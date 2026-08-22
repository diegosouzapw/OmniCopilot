import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { OmniRouteClient, OmniRouteError, describeFetchError, formatErrorValue, isThrottleError, isTransientHttpError } from "./client";
import { isReasoningModel, resolveReasoningEffort } from "./reasoning";

import { selectChatModels } from "./catalogFilter";
import { estimateTokens, toolCallSummary, toOpenAiMessages, toOpenAiTools } from "./convert";
import { containsVisibleText } from "./visibleText";
import {
  buildCatalog,
  cachedLoadRoutes,
  clearRouteCooldown,
  getClientForRoute,
  isRouteInCooldown,
  markRouteCooldown,
  pickFallbackCandidates,
  transportPlanForModel,
} from "./routes";
import type { ChatRequest, ChatUsageInfo, OmniRouteModel } from "./types";
import type { CatalogModel, FallbackCandidate, FallbackMode, RouteCatalog } from "./routes";
import { finiteNonNegative, subsetTokens, type ResolvedChatUsage } from "./usage";

interface OmniModelInfo extends vscode.LanguageModelChatInformation {
  omniModelId: string;
  routeId: string;
  /** Derived from the catalog entry's capabilities (reasoning/thinking):
   * gates sending `reasoning_effort` on models that support it. */
  supportsReasoning?: boolean;
}

export interface ProviderDeps {
  context: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  /** Called whenever a request round-trip settles, with success flag —
   * feeds the status bar without extra polling. */
  onActivity?: (ok: boolean, routeId?: string) => void;
  /** Live token usage while a chat response streams — feeds the status bar. */
  onUsage?: (usage: ResolvedChatUsage) => void;
  /** A chat request started streaming (status-bar live "responding" state). */
  onRequestStart?: (routeId: string | undefined, modelName: string) => void;
  /** A chat request settled. `error` is the surfaced failure message;
   * `fallbacksUsed` counts servers tried before the winning/exhausted one. */
  onRequestEnd?: (ok: boolean, error: string | undefined, fallbacksUsed: number) => void;
  /** routeIds that passed the most recent liveness probe; chat deprioritizes
   * the rest so unreachable servers aren't tried first. */
  getOnlineRouteIds?: () => ReadonlySet<string> | undefined;
  /** Called when a stream stalls (no SSE data within timeout). */
  onStall?: (routeId: string) => void;
}

function getConfig() {
  return vscode.workspace.getConfiguration("omnicopilot");
}

function formatContextLength(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return `${tokens}`;
}

/** Compiles the user's model filter regex. A malformed or overly long pattern
 * falls back to a safe literal substring match so the picker still works. */
function compileModelFilter(filterRaw: string): RegExp | undefined {
  if (!filterRaw) return undefined;
  try {
    if (filterRaw.length > 200) throw new Error("Filter too long");
    return new RegExp(filterRaw, "i");
  } catch {
    // invalid or overly complex regex → fall back to safe escaped substring matching
    const needle = filterRaw.slice(0, 200).toLowerCase();
    return new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`), "i");
  }
}

/** Small non-abortable pause between fallback attempts to avoid hammering a
 * busy server. Kept short; cancellation is re-checked on the next iteration. */
function delay(ms: number, token?: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (token) {
      token.onCancellationRequested(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}


/** HTTP status code carried by an OmniRouteError, if any. */
function errorStatus(err: unknown): number | undefined {
  return err instanceof OmniRouteError ? err.status : undefined;
}

/** Whether a failed candidate rejected request admission for this route. */
function isAdmissionSaturationError(err: unknown): boolean {
  const status = errorStatus(err);
  return status === 429 || status === 503 || isThrottleError(err);
}

/** Jittered delay between retries. Honors the upstream's Retry-After header
 * when present (capped at 30s) so a misbehaving server can't stall a request. */
function computeBackoffMs(err: unknown, isThrottle: boolean, attempted: number): number {
  const retryAfterMs = err instanceof OmniRouteError ? err.retryAfterMs : undefined;
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 10_000);
  const baseDelay = isThrottle ? 400 + crypto.randomInt(300) : 250;
  const maxDelay = isThrottle ? 1500 : 1000;
  return Math.min(maxDelay, baseDelay * (attempted + 1));
}

/** Parses a tool-call's JSON args defensively; `{}` on malformed input. */
function parseToolCallArgs(
  event: { args: string; name: string },
  log: vscode.LogOutputChannel
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    log.warn(`Tool call ${event.name} had invalid JSON args; sending {}`);
    return {};
  }
}

/** Everything needed to run the chat fallback chain for one request. */
interface ChatPlan {
  clientByRoute: Map<string, OmniRouteClient>;
  nameByRoute: Map<string, string>;
  candidates: FallbackCandidate[];
  serverCount: number;
  modelId: string;
  retriesPerServer: number;
}

/** Shared context for streaming against one fallback candidate. */
interface ChatCandidateContext {
  cand: FallbackCandidate;
  client: OmniRouteClient;
  i: number;
  request: ChatRequest;
  routeName: string;
  inputTokens: number;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
  abort: AbortController;
  log: vscode.LogOutputChannel;
  retriesPerServer: number;
}

/** Outcome of a single stream attempt. */
type StreamAttemptOutcome =
  | {
      kind: "completed";
      streamed: string;
      startedAt: number;
      firstTokenAt: number | undefined;
      reportedUsage?: ChatUsageInfo;
    }
  | { kind: "cancelled" }
  | { kind: "failed"; error: unknown; stall: boolean; throttle: boolean };

/** Outcome of a whole candidate (all of its retries). */
type CandidateOutcome =
  | { kind: "succeeded" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: unknown };

/** Final result of traversing the fallback candidates for one request. */
type ChatPlanOutcome =
  | { kind: "succeeded"; fallbacksUsed: number }
  | { kind: "cancelled"; fallbacksUsed: number }
  | { kind: "failed"; routeId: string | undefined; fallbacksUsed: number; error: unknown };

export class OmniRouteChatProvider
  implements vscode.LanguageModelChatProvider<OmniModelInfo>, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  private static readonly sharedRouteCatalogs = new Map<string, RouteCatalog>();
  private static readonly sharedRouteFetchPromises = new Map<string, Promise<RouteCatalog>>();
  private static sharedCachedModels: CatalogModel[] = [];
  private static sharedLastCatalogFetch = 0;
  private static sharedRefreshGeneration = 0;
  private static readonly CACHE_STATE_KEY = "omnicopilot.cachedCatalog.v1";
  private static readonly CACHE_TIME_KEY = "omnicopilot.cachedCatalogTime.v1";

  private static rebuildSharedCatalog(): CatalogModel[] {
    const segments = Array.from(OmniRouteChatProvider.sharedRouteCatalogs.values());
    const catalog = buildCatalog(segments);
    OmniRouteChatProvider.sharedCachedModels = catalog;
    return catalog;
  }

  static loadPersistentCache(context: vscode.ExtensionContext): void {
    const savedCatalog = context.globalState.get<CatalogModel[]>(OmniRouteChatProvider.CACHE_STATE_KEY);
    const savedTime = context.globalState.get<number>(OmniRouteChatProvider.CACHE_TIME_KEY);
    if (Array.isArray(savedCatalog) && savedCatalog.length > 0 && typeof savedTime === "number" && savedTime > 0) {
      OmniRouteChatProvider.sharedCachedModels = savedCatalog;
      OmniRouteChatProvider.sharedLastCatalogFetch = savedTime;

      // Reconstruct sharedRouteCatalogs from disk so per-route fallback / retention
      // works even if a route is slow or fails on its very first discovery run
      // after VS Code restarts or reloads.
      const byRoute = new Map<string, { routeId: string; name: string; models: OmniRouteModel[] }>();
      for (const item of savedCatalog) {
        if (!item?.entry?.routeId || !item?.model) continue;
        let seg = byRoute.get(item.entry.routeId);
        if (!seg) {
          seg = {
            routeId: item.entry.routeId,
            name: item.entry.routeName || item.entry.routeId,
            models: [],
          };
          byRoute.set(item.entry.routeId, seg);
        }
        seg.models.push(item.model);
      }
      for (const [routeId, seg] of byRoute) {
        OmniRouteChatProvider.sharedRouteCatalogs.set(routeId, seg);
      }
    }
  }

  private static async persistCache(context: vscode.ExtensionContext, catalog: CatalogModel[]): Promise<void> {
    // Persist a slim slice of each entry: full catalogs can hold thousands
    // of models and globalState is file-backed JSON (slow, storage-heavy).
    const slim: CatalogModel[] = catalog.map((c) => ({
      entry: {
        routeId: c.entry.routeId,
        routeName: c.entry.routeName,
        modelId: c.entry.modelId,
        prefixedId: c.entry.prefixedId,
      },
      model: {
        id: c.model.id,
        owned_by: c.model.owned_by,
        display_name: c.model.display_name,
        context_length: c.model.context_length,
        max_completion_tokens: c.model.max_completion_tokens,
        supported_endpoints: c.model.supported_endpoints,
        capabilities: {
          tool_calling: c.model.capabilities?.tool_calling,
          vision: c.model.capabilities?.vision,
          reasoning: c.model.capabilities?.reasoning,
          thinking: c.model.capabilities?.thinking,
        },
      },
    }));
    await context.globalState.update(OmniRouteChatProvider.CACHE_STATE_KEY, slim);
    await context.globalState.update(OmniRouteChatProvider.CACHE_TIME_KEY, Date.now());
  }

  /** Drops catalog segments whose routes are no longer configured, so model
   * discovery never serves stale entries. */
  private static pruneStaleRouteCatalogs(validRouteIds: Set<string>): boolean {
    let pruned = false;
    for (const key of Array.from(OmniRouteChatProvider.sharedRouteCatalogs.keys())) {
      if (!validRouteIds.has(key)) {
        OmniRouteChatProvider.sharedRouteCatalogs.delete(key);
        pruned = true;
      }
    }
    return pruned;
  }

  constructor(
    private readonly deps: ProviderDeps,
    public readonly filterRouteId?: string
  ) {}

  get cachedModels(): CatalogModel[] {
    return OmniRouteChatProvider.sharedCachedModels;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  /** Re-query the catalog and tell VS Code the model list changed. */
  async refresh(): Promise<void> {
    OmniRouteChatProvider.sharedRefreshGeneration++;
    OmniRouteChatProvider.sharedRouteFetchPromises.clear();
    OmniRouteChatProvider.sharedLastCatalogFetch = 0;
    this._onDidChange.fire();
  }


  // ── Model discovery ─────────────────────────────────────────────────────

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: vscode.CancellationToken
  ): Promise<OmniModelInfo[]> {
    const routes = await cachedLoadRoutes(this.deps.context);
    if (routes.length === 0) {
      OmniRouteChatProvider.sharedRouteCatalogs.clear();
      OmniRouteChatProvider.sharedCachedModels = [];
      OmniRouteChatProvider.sharedLastCatalogFetch = Date.now();
      void OmniRouteChatProvider.persistCache(this.deps.context, []);
      return [];
    }

    const validRouteIds = new Set(routes.map((r) => r.id));

    // Prune entries from sharedRouteCatalogs that belong to routes no longer configured
    if (OmniRouteChatProvider.pruneStaleRouteCatalogs(validRouteIds)) {
      OmniRouteChatProvider.sharedCachedModels = OmniRouteChatProvider.rebuildSharedCatalog();
      void OmniRouteChatProvider.persistCache(this.deps.context, OmniRouteChatProvider.sharedCachedModels);
    }

    const ttlMinutes = getConfig().get<number>("modelCacheTtlMinutes", 15);
    const isManualOnly = ttlMinutes <= 0;
    const ttlMs = isManualOnly ? Number.POSITIVE_INFINITY : ttlMinutes * 60_000;
    const isFresh = Date.now() - OmniRouteChatProvider.sharedLastCatalogFetch < ttlMs;

    if (OmniRouteChatProvider.sharedCachedModels.length > 0 && isFresh) {
      return this.toModelInfos(OmniRouteChatProvider.sharedCachedModels, validRouteIds);
    }

    const activeRoutes = routes.slice(0, 10);
    const refreshGeneration = OmniRouteChatProvider.sharedRefreshGeneration;

    const segments: RouteCatalog[] = await Promise.all(
      activeRoutes.map(async (r) => {
        let fetchP = OmniRouteChatProvider.sharedRouteFetchPromises.get(r.id);
        if (!fetchP) {
          fetchP = (async () => {
            try {
              const models = await getClientForRoute(r, this.deps.log).listModels();
              // Count what actually reaches the picker after catalog shaping
              // (specialty registries + dual-prefix mirrors are dropped), so a
              // silent all-drop (e.g. wrong `type` from a server version skew)
              // shows as "0/N" instead of a misleading "succeeded: N".
              const chatModels = selectChatModels(models);
              this.deps.onActivity?.(true, r.id);
              this.deps.log.info(
                `Route "${r.name}" (${r.baseUrl}) model discovery succeeded: ${chatModels.length}/${models.length} chat model(s)`
              );
              if (models.length > 0 && chatModels.length === 0) {
                const sample = models
                  .slice(0, 3)
                  .map(
                    (m) =>
                      `${m.id} (type=${m.type ?? "-"}, endpoints=${JSON.stringify(m.supported_endpoints ?? [])}, parent=${m.parent ?? "-"})`
                  )
                  .join(", ");
                this.deps.log.warn(
                  `Route "${r.name}" filtered out ALL ${models.length} model(s) — server catalog shape is incompatible. Sample: ${sample}`
                );
              }
              return { routeId: r.id, name: r.name, models };
            } catch (err) {
              this.deps.onActivity?.(false, r.id);
              this.deps.log.warn(
                `Route "${r.name}" (${r.baseUrl}) model discovery failed: ${formatErrorValue(err)}`
              );
              // A failed discovery must never wipe the picker: the route may be
              // alive but slow (headers past the budget, transient timeout),
              // and dropping its models makes the selected model vanish
              // mid-chat (VS Code then fails with NotFound, killing the chat).
              // Keep the last-known-good catalog until discovery succeeds again.
              const lastKnown = OmniRouteChatProvider.sharedRouteCatalogs.get(r.id);
              if (lastKnown && lastKnown.models.length > 0) {
                this.deps.log.warn(
                  `Route "${r.name}" discovery failed — keeping ${lastKnown.models.length} previously discovered model(s) from the last successful refresh`
                );
                return lastKnown;
              }
              // Secondary safety: if sharedRouteCatalogs was empty, check sharedCachedModels
              const fallbackModels = OmniRouteChatProvider.sharedCachedModels
                .filter((c) => c.entry.routeId === r.id)
                .map((c) => c.model);
              if (fallbackModels.length > 0) {
                this.deps.log.warn(
                  `Route "${r.name}" discovery failed — keeping ${fallbackModels.length} cached model(s)`
                );
                return { routeId: r.id, name: r.name, models: fallbackModels };
              }
              return { routeId: r.id, name: r.name, models: [] };
            }
          })().finally(() => {
            if (OmniRouteChatProvider.sharedRouteFetchPromises.get(r.id) === fetchP) {
              OmniRouteChatProvider.sharedRouteFetchPromises.delete(r.id);
            }
          });
          OmniRouteChatProvider.sharedRouteFetchPromises.set(r.id, fetchP);
        }
        return fetchP;
      })
    );

    if (refreshGeneration !== OmniRouteChatProvider.sharedRefreshGeneration) {
      return this.toModelInfos(OmniRouteChatProvider.sharedCachedModels, validRouteIds);
    }
    for (const seg of segments) {
      OmniRouteChatProvider.sharedRouteCatalogs.set(seg.routeId, seg);
    }
    const catalog = OmniRouteChatProvider.rebuildSharedCatalog();
    OmniRouteChatProvider.sharedLastCatalogFetch = Date.now();
    void OmniRouteChatProvider.persistCache(this.deps.context, catalog);

    const infos = this.toModelInfos(catalog, validRouteIds);
    if (infos.length === 0) {
      // No route answered with a model list matching this provider. Only prompt when the caller
      // wants it (model picker opened by the user); otherwise contribute none.
      if (!options.silent && !this.filterRouteId) void this.offerConnectionHelp();
      return [];
    }

    this.deps.log.info(
      `Listed ${infos.length} models for vendor (filterRouteId: ${this.filterRouteId ?? "all"}, total cached: ${catalog.length})`
    );
    return infos;
  }

  private toModelInfos(catalog: CatalogModel[], validRouteIds?: Set<string>): OmniModelInfo[] {
    const cfg = getConfig();
    const maxOutput = cfg.get<number>("maxOutputTokens", 16384);
    const defaultContext = cfg.get<number>("defaultContextLength", 128000);
    const filter = compileModelFilter(cfg.get<string>("modelFilter", "").trim());

    const infos: OmniModelInfo[] = [];
    for (const c of catalog) {
      if (!this.isModelEligible(c, filter, validRouteIds)) continue;
      infos.push(this.toModelInfo(c, maxOutput, defaultContext));
    }
    return infos;
  }

  /** Route/filter gating for one catalog entry: must belong to a valid route
   * (when given), match this provider's route (when scoped), carry an id, and
   * pass the user's model filter. */
  private isModelEligible(
    c: CatalogModel,
    filter: RegExp | undefined,
    validRouteIds?: Set<string>
  ): boolean {
    if (validRouteIds && !validRouteIds.has(c.entry.routeId)) return false;
    if (this.filterRouteId && c.entry.routeId !== this.filterRouteId) return false;
    const model = c.model;
    if (!model?.id) return false;
    if (filter && !filter.test(model.id)) return false;
    return true;
  }

  /** Builds the VS Code model descriptor for one catalog entry. */
  private toModelInfo(
    c: CatalogModel,
    maxOutput: number,
    defaultContext: number
  ): OmniModelInfo {
    const model = c.model;
    const contextLength = model.context_length ?? defaultContext;
    const maxOutputTokens = Math.min(model.max_completion_tokens ?? maxOutput, maxOutput);
    const caps = model.capabilities ?? {};
    const isCombo = model.owned_by === "combo";
    const displayName = model.display_name?.trim() || model.id;
    const supportsReasoning = isReasoningModel(model);
    const name = c.entry.routeName
      ? `${displayName} (${c.entry.routeName})`
      : displayName;

    const ctxTag = `${formatContextLength(contextLength)} ctx`;
    const capsTags: string[] = [ctxTag];
    if (supportsReasoning) capsTags.push("extended thinking");
    if (caps.vision === true) capsTags.push("vision");

    const routeLabel = c.entry.routeName || "OmniRoute";
    const tooltip = `${routeLabel} · ${model.id} (${capsTags.join(" · ")})`;

    return {
      id: c.entry.prefixedId,
      name,
      family: model.owned_by || "omniroute",
      version: "1.0.0",
      detail: isCombo ? "combo" : (c.entry.routeName || model.owned_by),
      tooltip,
      maxInputTokens: Math.max(contextLength - maxOutputTokens, 1024),
      maxOutputTokens,
      capabilities: {
        toolCalling: caps.tool_calling !== false,
        imageInput: caps.vision === true,
      },
      omniModelId: model.id,
      routeId: c.entry.routeId,
      supportsReasoning,
    };
  }

  private async offerConnectionHelp(): Promise<void> {
    const routes = await cachedLoadRoutes(this.deps.context);
    const baseUrl = routes[0]?.baseUrl ?? "http://localhost:20128/v1";

    const configureLabel = vscode.l10n.t("Configure Connection");
    const installLabel = vscode.l10n.t("Install OmniRoute");
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t("Could not reach OmniRoute at {0}. Is it running?", baseUrl),
      configureLabel,
      installLabel
    );
    if (pick === configureLabel) {
      void vscode.commands.executeCommand("omnicopilot.manage");
    } else if (pick === installLabel) {
      void vscode.commands.executeCommand("omnicopilot.installOmniRoute");
    }
  }

  // ── Chat ────────────────────────────────────────────────────────────────

  async provideLanguageModelChatResponse(
    model: OmniModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const log = this.deps.log;
    const request = this.buildChatRequest(model, messages, options, log);
    const plan = await this.resolveChatPlan(model, request, options, log);

    const abort = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abort.abort());

    // Estimate the input side of the request for the usage readout.
    const inputTokens = messages.reduce((n, msg) => n + estimateTokens(msg), 0);

    try {
      await this.executeChatPlan(plan, request, inputTokens, progress, token, abort);
    } finally {
      cancelSub.dispose();
    }
  }

  /** Builds the wire request for the selected model: OpenAI-compatible chat
   * payload with the user's tool cap, mandatory tool mode and temperature. */
  private buildChatRequest(
    model: OmniModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    log: vscode.LogOutputChannel
  ): ChatRequest {
    const request: ChatRequest = {
      model: model.omniModelId,
      messages: toOpenAiMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      tools: this.capTools(options.tools, log),
    };
    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      request.tool_choice = "required";
    }
    const modelOptions = options.modelOptions as Record<string, unknown> | undefined;
    if (typeof modelOptions?.temperature === "number") {
      request.temperature = modelOptions.temperature;
    }
    const effort = resolveReasoningEffort({
      modelOptions,
      configuredDefault: getConfig().get<string>("defaultReasoningEffort", ""),
      modelIsReasoning: Boolean(model.supportsReasoning),
    });
    if (effort) {
      request.reasoning_effort = effort;
    }
    return request;
  }

  /** Caps the tool list VS Code offered us, saving context: `maxTools <= 0`
   * means "send every tool"; a positive value is an explicit hard cap. */
  private capTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
    log: vscode.LogOutputChannel
  ): ReturnType<typeof toOpenAiTools> {
    const allTools = toOpenAiTools(tools);
    if (!allTools?.length) return allTools;
    const maxTools = getConfig().get<number>("maxTools", 0);
    if (maxTools > 0 && allTools.length <= maxTools) return allTools;
    if (maxTools > 0) {
      log.warn(`Limiting tools from ${allTools.length} to ${maxTools}`);
      return allTools.slice(0, maxTools);
    }
    return allTools;
  }

  /** Resolves the fallback chain for the selected model: primary → same model
   * on another route → same family on the same route → any compatible model.
   * A route disappearing mid-session is skipped, never fatal. Offline servers
   * are deprioritized so a dead secondary never delays a healthy primary. */
  private async resolveChatPlan(
    model: OmniModelInfo,
    request: ChatRequest,
    options: vscode.ProvideLanguageModelChatResponseOptions,
    log: vscode.LogOutputChannel
  ): Promise<ChatPlan> {
    const cfg = getConfig();
    const routes = await cachedLoadRoutes(this.deps.context);
    const firstByteTimeoutMs =
      cfg.get<number>("firstByteTimeoutSeconds", 120) * 1000;
    const compressionOverride = cfg.get<string>("compressionOverride", "serverDefault");
    const clientByRoute = new Map(
      routes.map((r) => [r.id, getClientForRoute(r, this.deps.log, firstByteTimeoutMs, compressionOverride)])
    );
    const nameByRoute = new Map(routes.map((r) => [r.id, r.name]));

    const primaryCatalogModel = this.cachedModels.find((c) => c.entry.prefixedId === model.id);
    const primaryEntry = primaryCatalogModel?.entry;
    if (!primaryEntry) {
      this.deps.log.warn(
        `Primary model not found in catalog: ${model.id} (${this.cachedModels.length} cached)`
      );
    }
    const fallbacks = primaryEntry
      ? pickFallbackCandidates(
          primaryEntry,
          this.cachedModels,
          Boolean(options.tools?.length),
          getConfig().get<FallbackMode>("fallbackMode", "sameModel")
        )
      : [];
    // The prefixedId is the source of truth for what the user selected.
    // Resolve the route from the catalog entry, NOT from model.routeId which
    // can be stale or point to a different server.
    if (!primaryEntry && (!model.routeId || !model.omniModelId)) {
      throw new OmniRouteError(`Model ${model.id} is not available or not properly configured`, undefined);
    }
    const primary: FallbackCandidate = primaryEntry
      ? {
          routeId: primaryEntry.routeId,
          modelId: primaryEntry.modelId,
          transportPlan: transportPlanForModel(primaryCatalogModel?.model),
        }
      : {
          routeId: model.routeId!,
          modelId: model.omniModelId!,
          transportPlan: ["responses", "chatCompletions"],
        };

    log.info(
      `Selected model: ${primary.modelId} on route ${primary.routeId} (prefixedId: ${model.id}, catalog: ${this.cachedModels.length} models)`
    );

    // Preserve fallback quality tiers while applying health within each tier.
    // An exact same-model route may bypass a cooling primary; same-family and
    // arbitrary substitutions never run before the selected model tier.
    const knownOnline = this.deps.getOnlineRouteIds?.() ?? new Set<string>();
    const primaryFamily = primary.modelId.split("/")[0];
    const qualityTier = (candidate: FallbackCandidate): number => {
      if (candidate.modelId === primary.modelId) return 0;
      if (candidate.modelId.split("/")[0] === primaryFamily) return 1;
      return 2;
    };
    const candidates = [primary, ...fallbacks].sort((a, b) => {
      const tierDifference = qualityTier(a) - qualityTier(b);
      if (tierDifference !== 0) return tierDifference;
      const aCooling = isRouteInCooldown(a.routeId) ? 1 : 0;
      const bCooling = isRouteInCooldown(b.routeId) ? 1 : 0;
      if (aCooling !== bCooling) return aCooling - bCooling;
      if (knownOnline.size > 0) {
        const aOnline = knownOnline.has(a.routeId) ? 0 : 1;
        const bOnline = knownOnline.has(b.routeId) ? 0 : 1;
        return aOnline - bOnline;
      }
      return 0;
    });

    const serverCount = new Set(candidates.map((c) => c.routeId)).size;

    // Pre-compute the fallback chain readout: building it inline would nest a
    // template literal inside another one (Sonar S4624).
    const fallbackSummary = candidates.slice(1).map((f) => `${f.routeId}:${f.modelId}`).join(", ");
    log.info(
      `Chat → ${primary.modelId} @${primary.routeId} (${request.messages.length} messages, ${request.tools?.length ?? 0} tools)` +
        (fallbacks.length ? `, fallbacks: ${fallbackSummary}` : "")
    );

    const retriesPerServer = getConfig().get<number>("retriesPerServer", 1);
    return {
      clientByRoute,
      nameByRoute,
      candidates,
      serverCount,
      modelId: model.omniModelId,
      retriesPerServer,
    };
  }

  /** Walks the fallback chain, one candidate at a time, until one succeeds or
   * every candidate is exhausted. Returns on success/cancellation; throws the
   * final error when the chain is exhausted. */
  private async executeChatPlan(
    plan: ChatPlan,
    request: ChatRequest,
    inputTokens: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    abort: AbortController
  ): Promise<void> {
    this.deps.onRequestStart?.(plan.candidates[0]?.routeId, plan.modelId);
    let requestSettled = false;

    try {
      const outcome = await this.runChatCandidates(plan, request, inputTokens, progress, token, abort);
      requestSettled = true;
      if (outcome.kind === "succeeded") {
        this.deps.onRequestEnd?.(true, undefined, outcome.fallbacksUsed);
        return;
      }
      if (outcome.kind === "cancelled") {
        this.deps.onRequestEnd?.(false, undefined, outcome.fallbacksUsed);
        return;
      }
      this.reportChatFailure({
        routeId: outcome.routeId,
        fallbacksUsed: outcome.fallbacksUsed,
        err: outcome.error,
        modelId: plan.modelId,
        serverCount: plan.serverCount,
        candidateCount: plan.candidates.length,
      });
    } catch (err) {
      if (!requestSettled) {
        requestSettled = true;
        this.deps.onRequestEnd?.(false, describeFetchError(err), 0);
      }
      throw err;
    }
  }

  /** Traverses fallback candidates without owning request lifecycle callbacks. */
  private async runChatCandidates(
    plan: ChatPlan,
    request: ChatRequest,
    inputTokens: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    abort: AbortController
  ): Promise<ChatPlanOutcome> {
    const candidates = plan.candidates;
    const saturatedRoutes = new Set<string>();
    let lastError: unknown;

    for (let i = 0; i < candidates.length;) {
      const cand = candidates[i];
      if (token.isCancellationRequested) return { kind: "cancelled", fallbacksUsed: i };
      if (saturatedRoutes.has(cand.routeId)) {
        this.deps.log.info(
          `Skipping fallback ${cand.modelId} @${cand.routeId}: route rejected admission earlier in this request`
        );
        i++;
        continue;
      }
      const client = plan.clientByRoute.get(cand.routeId);
      if (!client) {
        lastError = new OmniRouteError(`Route ${cand.routeId} is not configured`, undefined);
        i++;
        continue;
      }
      const outcome = await this.tryCandidate({
        cand,
        client,
        i,
        request,
        inputTokens,
        progress,
        token,
        abort,
        log: this.deps.log,
        routeName: plan.nameByRoute.get(cand.routeId) ?? cand.routeId,
        retriesPerServer: plan.retriesPerServer,
      });
      if (outcome.kind === "succeeded" || outcome.kind === "cancelled") {
        return { kind: outcome.kind, fallbacksUsed: i };
      }
      lastError = outcome.error;
      if (isAdmissionSaturationError(outcome.error)) saturatedRoutes.add(cand.routeId);
      const lastAttemptedIndex = this.advanceAfterCandidateFailure(plan, cand, outcome.error, i);
      if (lastAttemptedIndex >= candidates.length - 1) {
        return {
          kind: "failed",
          routeId: cand.routeId,
          fallbacksUsed: lastAttemptedIndex,
          error: outcome.error,
        };
      }
      i = lastAttemptedIndex + 1;
    }

    return {
      kind: "failed",
      routeId: candidates[0]?.routeId,
      fallbacksUsed: lastError === undefined ? candidates.length : candidates.length - 1,
      error: lastError ?? new OmniRouteError("No configured route served this model", undefined),
    };
  }

  /** Skips redundant same-route fallbacks after admission throttling. */
  private advanceAfterCandidateFailure(
    plan: ChatPlan,
    candidate: FallbackCandidate,
    error: unknown,
    index: number
  ): number {
    const status = errorStatus(error);
    const isThrottle = status === 503 || status === 429 || isThrottleError(error);
    let nextIndex = index;
    if (isThrottle) {
      nextIndex = this.skipSaturatedRouteCandidates(plan.candidates, candidate.routeId, nextIndex, status);
    }
    return nextIndex;
  }

  /** Skips other models on a route that has already rejected admission. */
  private skipSaturatedRouteCandidates(
    candidates: FallbackCandidate[],
    routeId: string,
    index: number,
    status: number | undefined
  ): number {
    let nextIndex = index;
    while (nextIndex + 1 < candidates.length && candidates[nextIndex + 1].routeId === routeId) {
      this.deps.log.info(
        `Skipping fallback ${candidates[nextIndex + 1].modelId} @${routeId}: server is admission-saturated (HTTP ${status ?? "503/429"})`
      );
      nextIndex++;
    }
    return nextIndex;
  }

  /** Retries one candidate until it succeeds, cancels, stalls, or exhausts
   * its attempts. Fatal errors (mid-stream or non-transient) propagate. */
  private async tryCandidate(ctx: ChatCandidateContext): Promise<CandidateOutcome> {
    const { cand, token, log, retriesPerServer } = ctx;
    const maxAttempts = Math.max(1, retriesPerServer + 1);
    let attempted = 0;
    let candError: unknown;

    for (; attempted < maxAttempts; attempted++) {
      if (token.isCancellationRequested) {
        return { kind: "cancelled" };
      }
      const attempt = await this.streamAttempt(ctx);
      if (attempt.kind === "completed") {
        clearRouteCooldown(cand.routeId);
        this.reportUsage(cand, attempt, ctx);
        this.deps.onActivity?.(true, cand.routeId);
        return { kind: "succeeded" };
      }
      if (attempt.kind === "cancelled") return { kind: "cancelled" };
      candError = attempt.error;
      log.warn(
        `Model ${cand.modelId} @${cand.routeId} attempt ${attempted + 1}/${maxAttempts} failed (${formatErrorValue(candError)})`
      );
      if (attempt.stall) {
        markRouteCooldown(cand.routeId, 15_000, 408, "Stream stall");
        this.deps.onStall?.(cand.routeId);
        break;
      }
      if (attempt.throttle) {
        const delayMs = computeBackoffMs(attempt.error, true, attempted);
        markRouteCooldown(cand.routeId, delayMs, errorStatus(attempt.error) ?? 429, "Admission throttle");
      } else if (candError instanceof OmniRouteError && candError.phase === "connect") {
        markRouteCooldown(cand.routeId, 10_000, undefined, "Connection failure");
      }
      if (attempted + 1 < maxAttempts) {
        await delay(computeBackoffMs(attempt.error, attempt.throttle, attempted), token);
      }
    }

    log.warn(
      `Server ${cand.routeId} gave up after ${attempted} attempt(s) (${formatErrorValue(candError)}); next server`
    );
    return { kind: "failed", error: candError };
  }

  /** Feeds the status bar's live usage readout after a completed stream. */
  private reportUsage(
    cand: FallbackCandidate,
    attempt: Extract<StreamAttemptOutcome, { kind: "completed" }>,
    ctx: ChatCandidateContext
  ): void {
    const reportedInputTokens = finiteNonNegative(attempt.reportedUsage?.inputTokens);
    const reportedOutputTokens = finiteNonNegative(attempt.reportedUsage?.outputTokens);
    const inputTokenProvenance = reportedInputTokens === undefined ? "estimated" : "reported";
    const outputTokenProvenance = reportedOutputTokens === undefined ? "estimated" : "reported";
    const inputTokens =
      reportedInputTokens ?? finiteNonNegative(ctx.inputTokens) ?? 0;
    const outputTokens =
      reportedOutputTokens ?? estimateTokens(attempt.streamed);
    const cachedTokens = subsetTokens(attempt.reportedUsage?.cachedTokens, inputTokens);
    const reasoningTokens = subsetTokens(attempt.reportedUsage?.reasoningTokens, outputTokens);

    this.deps.onUsage?.({
      routeId: cand.routeId,
      baseUrl: ctx.client?.baseUrl ?? "",
      serverName: ctx.routeName,
      modelName: cand.modelId,
      inputTokens,
      outputTokens,
      ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      inputTokenProvenance,
      outputTokenProvenance,
    });
  }

  /** One stream attempt: consumes events, reports parts, and classifies the
   * outcome. Cancellation is honored at every checkpoint. */
  private async streamAttempt(ctx: ChatCandidateContext): Promise<StreamAttemptOutcome> {
    const { cand, client, request, progress, token, abort, log } = ctx;
    let streamed = "";
    let reportedAny = false;
    const startedAt = Date.now();
    let firstTokenAt: number | undefined;
    try {
      const consumed = await this.consumeStream(
        client,
        { ...request, model: cand.modelId },
        abort,
        progress,
        token,
        cand.transportPlan,
        () => {
          reportedAny = true;
        }
      );
      streamed = consumed.streamed;
      reportedAny = consumed.reportedAny;
      firstTokenAt = consumed.firstTokenAt;
      if (!reportedAny) {
        log.warn(`Model ${cand.modelId} @${cand.routeId} returned an empty stream; emitting empty text part`);
        progress.report(new vscode.LanguageModelTextPart(""));
      }
      // User cancelled after the first tokens: the request did not complete —
      // don't count it as success or bill usage.
      if (token.isCancellationRequested) {
        return { kind: "cancelled" };
      }
      if (!consumed.hasVisibleText && consumed.toolNames.length > 0) {
        progress.report(new vscode.LanguageModelTextPart(toolCallSummary(consumed.toolNames)));
      }
      const finishedAt = Date.now();
      const outputCount = consumed.reportedUsage?.outputTokens ?? estimateTokens(streamed);
      const cachedSuffix = consumed.reportedUsage?.cachedTokens
        ? `, cached: ${consumed.reportedUsage.cachedTokens}`
        : "";
      log.info(
        `Chat ✓ ${cand.modelId} @${cand.routeId} (TTFT: ${firstTokenAt ? firstTokenAt - startedAt : "n/a"}ms, total: ${finishedAt - startedAt}ms, output: ${outputCount} tokens${cachedSuffix})`
      );
      return { kind: "completed", streamed, startedAt, firstTokenAt, reportedUsage: consumed.reportedUsage };
    } catch (err) {
      return this.concludeStreamFailure(err, reportedAny, ctx);
    }
  }

  /** Consumes one SSE stream, reporting text and tool-call parts as they
   * arrive. Stops early on cancellation. */
  private async consumeStream(
    client: OmniRouteClient,
    request: ChatRequest,
    abort: AbortController,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    transportPlan: FallbackCandidate["transportPlan"],
    onReported: () => void
  ): Promise<{
    streamed: string;
    reportedAny: boolean;
    firstTokenAt: number | undefined;
    hasVisibleText: boolean;
    toolNames: string[];
    reportedUsage?: ChatUsageInfo;
  }> {
    let streamed = "";
    let reportedAny = false;
    let firstTokenAt: number | undefined;
    let hasVisibleText = false;
    const toolNames: string[] = [];
    let reportedUsage: ChatUsageInfo | undefined;
    for await (const event of client.streamModel(request, abort.signal, transportPlan)) {
      if (token.isCancellationRequested) break;
      if (event.kind === "text") {
        firstTokenAt ??= Date.now();
        streamed += event.text;
        hasVisibleText ||= containsVisibleText(event.text);
        reportedAny = true;
        onReported();
        progress.report(new vscode.LanguageModelTextPart(event.text));
      } else if (event.kind === "usage") {
        reportedUsage = {
          ...reportedUsage,
          ...event.usage,
          inputTokens: event.usage.inputTokens ?? reportedUsage?.inputTokens,
          outputTokens: event.usage.outputTokens ?? reportedUsage?.outputTokens,
          cachedTokens: event.usage.cachedTokens ?? reportedUsage?.cachedTokens,
          reasoningTokens: event.usage.reasoningTokens ?? reportedUsage?.reasoningTokens,
          totalTokens: event.usage.totalTokens ?? reportedUsage?.totalTokens,
        };
      } else {
        const toolEvent = event as { id: string; name: string; args: string };
        if (toolEvent.name) {
          if (!toolNames.includes(toolEvent.name)) toolNames.push(toolEvent.name);
          reportedAny = true;
          onReported();
          progress.report(
            new vscode.LanguageModelToolCallPart(toolEvent.id, toolEvent.name, parseToolCallArgs(toolEvent, this.deps.log))
          );
        }
      }
    }
    return { streamed, reportedAny, firstTokenAt, hasVisibleText, toolNames, reportedUsage };
  }

  /** Classifies a failed attempt: cancellation, mid-stream/fatal → throw,
   * anything transient → retryable with stall/throttle flags. */
  private concludeStreamFailure(
    err: unknown,
    reportedAny: boolean,
    ctx: ChatCandidateContext
  ): StreamAttemptOutcome {
    const { cand, token, log } = ctx;
    if (token.isCancellationRequested) {
      return { kind: "cancelled" };
    }
    if (reportedAny) {
      this.deps.onActivity?.(false, cand.routeId);
      log.error(`Chat request failed mid-stream: ${formatErrorValue(err)}`);
      throw err;
    }
    const status = errorStatus(err);
    // Network-level failures (no HTTP status, e.g. `fetch failed`) are
    // treated as transient so the server can be re-attempted.
    const transient = status === undefined || isTransientHttpError(status);
    if (!transient) {
      this.deps.onActivity?.(false, cand.routeId);
      log.error(`Chat request failed: ${formatErrorValue(err)}`);
      throw err;
    }
    return {
      kind: "failed",
      error: err,
      stall: err instanceof OmniRouteError && err.stall,
      throttle: status === 503 || status === 429 || isThrottleError(err),
    };
  }

  /** Reports the final failure to extension state, then lets VS Code surface it. */
  private reportChatFailure(args: {
    routeId: string | undefined;
    fallbacksUsed: number;
    err: unknown;
    modelId: string;
    serverCount: number;
    candidateCount: number;
  }): never {
    const { routeId, fallbacksUsed, err, candidateCount } = args;
    this.deps.onActivity?.(false, routeId);
    this.deps.log.error(`Chat request failed after ${candidateCount} model(s): ${formatErrorValue(err)}`);
    this.deps.onRequestEnd?.(false, describeFetchError(err), fallbacksUsed);
    throw err;
  }

  // ── Token counting ──────────────────────────────────────────────────────

  async provideTokenCount(
    _model: OmniModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    return estimateTokens(text);
  }
}
