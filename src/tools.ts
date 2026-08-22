import * as vscode from "vscode";
import { isTransientHttpError, OmniRouteClient, OmniRouteError } from "./client";
import { cachedLoadRoutes, getClientForRoute } from "./routes";
import { normalizeSupportedEndpoint } from "./supportedEndpoints";
import type { OmniLogger } from "./client";
import type { OmniRouteModel, RerankRequest, SearchRequest } from "./types";
import type { Route } from "./routes";

export const SEARCH_TOOL_NAME = "omniroute_search";
export const RERANK_TOOL_NAME = "omniroute_rerank";

export interface SearchToolInput {
  query: string;
  model?: string;
  routeId?: string;
  max_results?: number;
  search_type?: "web" | "news";
}

export interface RerankToolInput {
  query: string;
  documents: string[];
  model?: string;
  routeId?: string;
  top_n?: number;
  return_documents?: boolean;
}

interface ToolDeps {
  context: vscode.ExtensionContext;
  log: OmniLogger;
  loadRoutes?: (context: vscode.ExtensionContext) => Promise<Route[]>;
  getClient?: (route: Route, log?: OmniLogger) => OmniRouteClient;
}

interface Candidate {
  route: Route;
  client: OmniRouteClient;
  model: OmniRouteModel;
}

type Endpoint = "/search" | "/rerank";

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error("The operation was cancelled");
}

function validateQuery(value: unknown, maxLength?: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("query must be a non-empty string");
  const query = value.trim();
  if (maxLength !== undefined && query.length > maxLength) {
    throw new Error(`query must be at most ${maxLength} characters`);
  }
  return query;
}

function validateSearch(input: SearchToolInput): SearchRequest {
  const maxResults = input.max_results ?? 5;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
    throw new Error("max_results must be an integer between 1 and 100");
  }
  const searchType = input.search_type ?? "web";
  if (searchType !== "web" && searchType !== "news") {
    throw new Error("search_type must be either web or news");
  }
  return { query: validateQuery(input.query, 500), max_results: maxResults, search_type: searchType };
}

function validateRerank(input: RerankToolInput): Omit<RerankRequest, "model"> {
  if (!Array.isArray(input.documents) || input.documents.length === 0) {
    throw new Error("documents must contain at least one string");
  }
  if (input.documents.some((document) => typeof document !== "string")) {
    throw new Error("documents must contain only strings");
  }
  if (input.top_n !== undefined) {
    if (!Number.isInteger(input.top_n) || input.top_n < 1) throw new Error("top_n must be a positive integer");
    if (input.top_n > input.documents.length) throw new Error("top_n cannot exceed the number of documents");
  }
  return {
    query: validateQuery(input.query),
    documents: input.documents,
    ...(input.top_n === undefined ? {} : { top_n: input.top_n }),
    ...(input.return_documents === undefined ? {} : { return_documents: input.return_documents }),
  };
}

function supportsEndpoint(model: OmniRouteModel, endpoint: Endpoint): boolean {
  return Array.isArray(model.supported_endpoints) &&
    model.supported_endpoints.some((value) => normalizeSupportedEndpoint(value) === endpoint);
}

function isTransientFailure(error: unknown): boolean {
  if (error instanceof OmniRouteError) {
    return error.status === undefined || isTransientHttpError(error.status);
  }
  return error instanceof TypeError || (error instanceof Error && /timeout|timed out|econn|network|fetch failed/i.test(error.message));
}

function result(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value)),
  ]);
}

async function candidatesFor(
  deps: ToolDeps,
  endpoint: Endpoint,
  routeId: string | undefined,
  modelOverride: string | undefined,
  token: vscode.CancellationToken
): Promise<Candidate[]> {
  const loadRoutes = deps.loadRoutes ?? cachedLoadRoutes;
  const getClient = deps.getClient ?? getClientForRoute;
  const configured = (await loadRoutes(deps.context)).slice(0, 10);
  const routes = routeId ? configured.filter((route) => route.id === routeId) : configured;
  if (routeId && routes.length === 0) throw new Error(`Unknown OmniRoute routeId "${routeId}"`);
  if (configured.length === 0) throw new Error("No OmniRoute routes are configured");

  const discovered = await Promise.all(routes.map(async (route) => {
    throwIfCancelled(token);
    const client = getClient(route, deps.log);
    try {
      const models = await client.listModels(token);
      throwIfCancelled(token);
      return models
        .filter((model) => supportsEndpoint(model, endpoint))
        .filter((model) => !modelOverride || model.id === modelOverride)
        .map((model) => ({ route, client, model }));
    } catch (error) {
      if (token.isCancellationRequested) throw error;
      deps.log.warn(`Could not inspect route "${route.id}" for ${endpoint}: ${String(error)}`);
      return [];
    }
  }));
  throwIfCancelled(token);
  const candidates = discovered.flat();
  if (candidates.length === 0 && modelOverride) {
    const routeSuffix = routeId ? ` on route "${routeId}"` : "";
    throw new Error(`Model override "${modelOverride}" does not support ${endpoint}${routeSuffix}`);
  }
  if (candidates.length === 0) throw new Error(`No configured OmniRoute model supports ${endpoint}`);
  return candidates;
}

async function executeWithFailover<T>(
  candidates: Candidate[],
  token: vscode.CancellationToken,
  log: OmniLogger,
  run: (candidate: Candidate, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const ctrl = new AbortController();
  const sub = token.onCancellationRequested(() => ctrl.abort(new Error("The operation was cancelled")));
  if (token.isCancellationRequested) ctrl.abort(new Error("The operation was cancelled"));
  try {
    let lastError: unknown;
    for (const candidate of candidates) {
      if (ctrl.signal.aborted) throw ctrl.signal.reason;
      try {
        return await run(candidate, ctrl.signal);
      } catch (error) {
        lastError = error;
        if (!isTransientFailure(error)) throw error;
        log.warn(`Tool request failed transiently on route "${candidate.route.id}" (${candidate.model.id}); trying the next candidate`);
      }
    }
    throw lastError ?? new Error("No OmniRoute tool candidate was available");
  } finally {
    sub.dispose();
  }
}

export function createFixedTools(deps: ToolDeps): {
  search: vscode.LanguageModelTool<SearchToolInput>;
  rerank: vscode.LanguageModelTool<RerankToolInput>;
} {
  return {
    search: {
      async invoke(options, token) {
        const request = validateSearch(options.input);
        const candidates = await candidatesFor(deps, "/search", options.input.routeId, options.input.model?.trim() || undefined, token);
        const response = await executeWithFailover(candidates, token, deps.log, (candidate, signal) =>
          candidate.client.search({
            ...request,
            provider: options.input.model?.trim() || candidate.model.id,
          }, signal)
        );
        return result(response);
      },
    },
    rerank: {
      async invoke(options, token) {
        const request = validateRerank(options.input);
        const candidates = await candidatesFor(deps, "/rerank", options.input.routeId, options.input.model?.trim() || undefined, token);
        const response = await executeWithFailover(candidates, token, deps.log, (candidate, signal) =>
          candidate.client.rerank({ ...request, model: options.input.model?.trim() || candidate.model.id }, signal)
        );
        return result(response);
      },
    },
  };
}

export function registerFixedTools(context: vscode.ExtensionContext, log: OmniLogger): void {
  const tools = createFixedTools({ context, log });
  context.subscriptions.push(
    vscode.lm.registerTool(SEARCH_TOOL_NAME, tools.search),
    vscode.lm.registerTool(RERANK_TOOL_NAME, tools.rerank)
  );
}
