import * as vscode from "vscode";
import { OmniRouteClient, normalizeBaseUrl } from "./client";
import { selectChatModels } from "./catalogFilter";
import { classifySupportedEndpoints } from "./supportedEndpoints";
import type { OmniLogger } from "./client";
import type { ModelTransport, ModelTransportPlan, OmniRouteModel, RouteConfig } from "./types";

/** Legacy single-route secret (migrated into route-1). */
export const SECRET_API_KEY = "omnicopilot.apiKey";
/** Per-route secret prefix: `omnicopilot.apiKey.<routeId>`. */
export const SECRET_PREFIX = "omnicopilot.apiKey.";

export interface Route extends RouteConfig {
  apiKey?: string;
}

/** Load configured routes. When `omnicopilot.routes` was never written (null),
 * the legacy `baseUrl`+`apiKey` become `route-1` (silent migration, no config
 * write). An explicit empty array stays empty — no resurrection. */
export async function loadRoutes(context: vscode.ExtensionContext): Promise<Route[]> {
  const cfg = vscode.workspace.getConfiguration("omnicopilot");
  const configured = cfg.get<RouteConfig[] | null>("routes", null);

  if (configured && configured.length > 0) {
    return Promise.all(
      configured.map(async (r) => ({
        id: r.id,
        name: r.name,
        baseUrl: normalizeBaseUrl(r.baseUrl),
        apiKey: (await context.secrets.get(SECRET_PREFIX + r.id)) || undefined,
      }))
    );
  }

  if (configured === null) {
    const legacyUrl = cfg.get<string>("baseUrl", "");
    if (legacyUrl) {
      const legacyKey = await context.secrets.get(SECRET_API_KEY);
      return [
        {
          id: "route-1",
          name: hostLabelOf(legacyUrl),
          baseUrl: normalizeBaseUrl(legacyUrl),
          apiKey: legacyKey || undefined,
        },
      ];
    }
  }

  return [];
}

/** Best-effort secret deletion (Thenable API, errors ignored). */
function clearSecret(context: vscode.ExtensionContext, id: string): Thenable<void> {
  return context.secrets.delete(id).then(undefined, () => undefined);
}

/** Persist routes: URLs → config, keys → secrets. Deletes secrets only of
 * routes removed since the last config read. A route kept in the list without
 * an `apiKey` keeps its existing secret (the panel form sends `""` when the
 * user does not retype the key, so this must be a no-op). Clearing a key on a
 * kept route goes through the explicit `setKey`/`clearKey` paths. */
export async function saveRoutes(
  context: vscode.ExtensionContext,
  routes: Route[]
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("omnicopilot");
  const prior = cfg.get<RouteConfig[]>("routes", []) ?? [];

  // Defensive id normalization: a blank or duplicate (within this batch) id
  // would collide in the client pool and SecretStorage (`omnicopilot.apiKey.<id>`).
  // Kept ids from `prior` are reused as-is; only blank/duplicate ones are
  // re-keyed to a monotonic `route-N` that avoids kept ids too.
  const seen = new Set<string>();
  const numbered: Route[] = [];
  const normalized: Route[] = routes.map((r) => {
    const id = (r.id || "").trim();
    const route = { ...r };
    if (!id || seen.has(id)) {
      route.id = newRouteId([...numbered, ...prior]);
    } else {
      route.id = id;
      seen.add(id);
    }
    numbered.push(route);
    return route;
  });
  routes = normalized;

  const remaining = new Set(routes.map((r) => r.id));
  for (const p of prior) {
    if (!remaining.has(p.id)) await clearSecret(context, SECRET_PREFIX + p.id);
  }

  await cfg.update(
    "routes",
    routes.map((r) => ({ id: r.id, name: r.name, baseUrl: normalizeBaseUrl(r.baseUrl) })),
    vscode.ConfigurationTarget.Global
  );

  for (const r of routes) {
    if (r.apiKey) {
      await context.secrets.store(SECRET_PREFIX + r.id, r.apiKey.trim());
    }
  }
  invalidateRouteCache();
}

/** Next sequential route id (`route-N`), monotonic over existing ids. */
export function newRouteId(routes: Route[]): string {
  let max = 0;
  for (const r of routes) {
    const n = Number(r.id.replace(/^route-/, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `route-${max + 1}`;
}

// ── Route cache ────────────────────────────────────────────────────────
let _cachedRoutes: Route[] | undefined;
let _cacheContext: vscode.ExtensionContext | undefined;

// ── Ephemeral Route Cooldowns ──────────────────────────────────────────
export interface RouteCooldown {
  routeId: string;
  cooldownUntil: number;
  status?: number;
  reason?: string;
}

const _routeCooldowns = new Map<string, RouteCooldown>();

export function markRouteCooldown(
  routeId: string,
  durationMs: number,
  status?: number,
  reason?: string
): void {
  if (!routeId || durationMs <= 0) return;
  const cooldownUntil = Date.now() + Math.min(durationMs, 60_000);
  _routeCooldowns.set(routeId, {
    routeId,
    cooldownUntil,
    status,
    reason,
  });
}

export function isRouteInCooldown(routeId: string): boolean {
  const cd = _routeCooldowns.get(routeId);
  if (!cd) return false;
  if (Date.now() >= cd.cooldownUntil) {
    _routeCooldowns.delete(routeId);
    return false;
  }
  return true;
}

export function clearRouteCooldown(routeId: string): void {
  _routeCooldowns.delete(routeId);
}

export function getRouteCooldown(routeId: string): RouteCooldown | undefined {
  if (isRouteInCooldown(routeId)) {
    return _routeCooldowns.get(routeId);
  }
  return undefined;
}

export function resetAllCooldowns(): void {
  _routeCooldowns.clear();
}

/** Invalidate the route cache. Call on config change or after `saveRoutes`. */
export function invalidateRouteCache(): void {
  _cachedRoutes = undefined;
  _clientPool.clear();
  resetAllCooldowns();
}

/** Cached `loadRoutes`. Reads config + secrets only once until invalidated. */
export async function cachedLoadRoutes(context: vscode.ExtensionContext): Promise<Route[]> {
  if (_cachedRoutes && _cacheContext === context) return _cachedRoutes;
  _cacheContext = context;
  _cachedRoutes = await loadRoutes(context);
  return _cachedRoutes;
}

// ── Client pool ────────────────────────────────────────────────────────
const _clientPool = new Map<string, OmniRouteClient>();

/** Reusable client for a route. Keyed by `routeId`; invalidated with routes. */
export function getClientForRoute(
  route: Route,
  log?: OmniLogger,
  streamFirstByteTimeoutMs?: number,
  compressionOverride?: string
): OmniRouteClient {
  const existing = _clientPool.get(route.id);
  if (
    existing?.baseUrl === normalizeBaseUrl(route.baseUrl) &&
    existing.options.apiKey === route.apiKey &&
    existing.options.streamFirstByteTimeoutMs === streamFirstByteTimeoutMs &&
    existing.options.compressionOverride === compressionOverride &&
    existing.options.log === log
  ) {
    return existing;
  }
  const client = makeClientForRoute(route, log, streamFirstByteTimeoutMs, compressionOverride);
  _clientPool.set(route.id, client);
  return client;
}

/** Fresh client for a single route (stateless; callers may build them cheaply).
 * Prefer `getClientForRoute` for pooled access (health-checks, model discovery). */
export function makeClientForRoute(
  route: Route,
  log?: OmniLogger,
  streamFirstByteTimeoutMs?: number,
  compressionOverride?: string
): OmniRouteClient {
  return new OmniRouteClient({
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    chatMaxAttempts: 1,
    streamFirstByteTimeoutMs,
    compressionOverride,
    log,
  });
}

/** Canonical vendor string for VS Code model provider registration (e.g. omniroute-Ashburn). */
export function vendorForRoute(
  route: { id: string; name: string },
  allRoutes: { id: string; name: string }[]
): string {
  const clean = route.name.trim() || route.id;
  const matches = allRoutes.filter((r) => (r.name.trim() || r.id) === clean);
  if (matches.length > 1) {
    return `omniroute-${clean}-${route.id}`;
  }
  return `omniroute-${clean}`;
}

/** Host portion of a URL → auto-generated route name on migration. */
function hostLabelOf(raw: string): string {
  try {
    return new URL(normalizeBaseUrl(raw)).hostname || "route-1";
  } catch {
    return "route-1";
  }
}

/** One model from one route in the united catalog. */
export interface CatalogEntry {
  routeId: string;
  /** Route's assigned Name (for display in the model picker). */
  routeName: string;
  /** Original server model id — the one sent to the API. */
  modelId: string;
  /** Exposed, always-unique VS Code id (`name · modelId`). */
  prefixedId: string;
}

export interface CatalogModel {
  entry: CatalogEntry;
  model: OmniRouteModel;
}

export interface FallbackCandidate {
  routeId: string;
  modelId: string;
  transportPlan: ModelTransportPlan;
}

export interface RouteCatalog {
  routeId: string;
  name: string;
  models: OmniRouteModel[];
}

/** Sanitized, prefixed, unique model id. Collisions get ` #<routeId>` appended. */
export function prefixedId(
  routeName: string,
  routeId: string,
  modelId: string,
  taken: ReadonlySet<string>
): string {
  const clean = routeName.trim().replace(/[^A-Za-z0-9 _.+-]/g, "").slice(0, 20);
  const base = `${clean || routeId} · ${modelId}`;
  return taken.has(base) ? `${base} #${routeId}` : base;
}

/** Union of per-route raw catalogs into deduped, prefixed, route-tagged models. */
export function buildCatalog(perRoute: RouteCatalog[]): CatalogModel[] {
  const taken = new Set<string>();
  const out: CatalogModel[] = [];
  for (const r of perRoute) {
    const chatModels = selectChatModels(r.models);
    for (const model of chatModels) {
      if (!model?.id) continue;
      const prefixed = prefixedId(r.name, r.routeId, model.id, taken);
      taken.add(prefixed);
      out.push({
        entry: { routeId: r.routeId, routeName: r.name, modelId: model.id, prefixedId: prefixed },
        model,
      });
    }
  }
  return out;
}

export type FallbackMode = "none" | "sameModel" | "sameFamily" | "full";

/** Derive the complete pre-output protocol plan from catalog metadata.
 * Missing, empty, and wholly unknown metadata retain the compatibility plan;
 * explicit metadata is authoritative. Legacy Completions and specialty-only
 * models have no chat plan. */
export function transportPlanForModel(model: OmniRouteModel | undefined): ModelTransportPlan {
  const endpoints = model?.supported_endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    return ["responses", "chatCompletions"];
  }
  const classes = classifySupportedEndpoints(endpoints);
  const plan: ModelTransport[] = [];
  if (classes.has("responses")) plan.push("responses");
  if (classes.has("chatCompletions")) plan.push("chatCompletions");
  if (classes.has("messages")) plan.push("messages");
  if (plan.length > 0) return plan;
  if (classes.size === 1 && classes.has("unknown")) {
    return ["responses", "chatCompletions"];
  }
  return [];
}

/** Ordered cross-route fallback candidates for a failing chat request.
 *
 * `mode` controls how far the chain reaches:
 * - `none`: only the primary model; never substitute.
 * - `sameModel`: the same model id on another configured server.
 * - `sameFamily`: additionally the same provider family on the same server.
 * - `full`: then any compatible model anywhere (legacy behaviour).
 *
 * When tools are needed, models reporting `tool_calling: false` are filtered
 * out. The primary model is always excluded. */
export function pickFallbackCandidates(
  primary: CatalogEntry,
  catalog: CatalogModel[],
  needsTools: boolean,
  mode: FallbackMode = "full",
  max = 4
): FallbackCandidate[] {
  const compatible = (c: CatalogModel) =>
    !needsTools || c.model.capabilities?.tool_calling !== false;
  const family = primary.modelId.split("/")[0];

  const out: FallbackCandidate[] = [];
  const seen = new Set<string>([primary.prefixedId]);
  const push = (c: CatalogModel) => {
    if (seen.has(c.entry.prefixedId)) return;
    seen.add(c.entry.prefixedId);
    out.push({
      routeId: c.entry.routeId,
      modelId: c.entry.modelId,
      transportPlan: transportPlanForModel(c.model),
    });
  };

  if (mode === "none") return out;

  catalog
    .filter((c) => compatible(c) && c.entry.modelId === primary.modelId && c.entry.routeId !== primary.routeId)
    .forEach(push);

  if (mode !== "sameModel") {
    catalog
      .filter(
        (c) =>
          compatible(c) &&
          c.entry.routeId === primary.routeId &&
          c.entry.modelId !== primary.modelId &&
          c.entry.modelId.split("/")[0] === family
      )
      .forEach(push);
  }

  if (mode === "full") {
    catalog
      .filter((c) => compatible(c) && c.entry.prefixedId !== primary.prefixedId)
      .forEach(push);
  }

  return out.slice(0, max);
}
