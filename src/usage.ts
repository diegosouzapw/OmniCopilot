/**
 * Client + shaping for OmniRoute's self-service usage endpoint
 * (`GET /api/usage/om-usage?format=json`), the server half of OmniCopilot #8.
 *
 * The shapes below mirror `UsageCommandJson` in the OmniRoute repo
 * (`src/lib/usage/internalUsageCommand.ts`). They are re-declared here rather
 * than imported because the extension ships standalone — keep the field names
 * aligned with the server when either side changes.
 */

export interface UsageLimitStatus {
  enabled: boolean;
  dailyLimitUsd: number | null;
  weeklyLimitUsd: number | null;
  dailySpentUsd: number;
  weeklySpentUsd: number;
  dailyResetAtIso: string;
  weeklyResetAtIso: string | null;
  dailyExceeded: boolean;
  weeklyExceeded: boolean;
}

export interface UsageQuotaWindow {
  used?: number;
  total?: number;
  remaining?: number;
  resetAt?: string | null;
}

export interface UsageSnapshot {
  connectionId: string;
  provider: string;
  plan?: unknown;
  quotas?: Record<string, UsageQuotaWindow>;
}

/** Refusals carry only an error; success carries the data. A panel must never
 * read a data field off a refusal — hence the discriminated union. */
export type UsageResponse =
  | { allowed: false; error?: { message?: string } }
  | {
      allowed: true;
      personal: UsageLimitStatus | null;
      provider: UsageSnapshot | null;
      /** Every connection's snapshot (#11191); absent on servers that predate it. */
      providers?: UsageSnapshot[];
    };

/** What the panel actually renders — the three reachable states, resolved.
 * "unsupported" is a server too old for ?format=json (it answered text), which
 * must hide the section rather than show a parser error. */
export type UsageView =
  | { kind: "unsupported" }
  | { kind: "disabled"; message?: string }
  | { kind: "ready"; personal: UsageLimitStatus | null; providers: UsageSnapshot[] };

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? USD.format(value) : "—";
}

/** "resets in 2d 4h" / "resets in 3h 12m" / "unknown" — mirrors the server's
 * formatResetIn so the panel reads like the terminal command. */
export function formatResetIn(resetAtIso: string | null | undefined, now = Date.now()): string {
  if (!resetAtIso) return "unknown";
  const ms = Date.parse(resetAtIso);
  if (!Number.isFinite(ms)) return "unknown";
  const diff = ms - now;
  if (diff <= 0) return "now";
  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Percent of the limit still available, for the personal USD rows. */
export function percentLeft(spent: number, limit: number | null): number | null {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - spent / limit) * 100)));
}

/** Resolve the raw response into the panel's three states. Centralises the
 * "older servers answer text" fallback and the providers/provider merge. */
export function toUsageView(body: UsageResponse): UsageView {
  if (body.allowed === false) return { kind: "disabled", message: body.error?.message };
  const providers = Array.isArray(body.providers)
    ? body.providers
    : body.provider
      ? [body.provider]
      : [];
  return { kind: "ready", personal: body.personal ?? null, providers };
}

/** GET the usage endpoint. Throws `UsageUnsupportedError` when the server
 * answered text — an OmniRoute that predates ?format=json — so the caller
 * hides the section instead of surfacing a parse failure. */
export class UsageUnsupportedError extends Error {}

export async function fetchUsage(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs = 6000
): Promise<UsageView> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
    const res = await fetch(`${root}/api/usage/om-usage?format=json`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      // Older OmniRoute (or a refusal on an old server) answers text/plain.
      throw new UsageUnsupportedError("server predates ?format=json");
    }
    const body = (await res.json()) as UsageResponse;
    return toUsageView(body);
  } finally {
    clearTimeout(timer);
  }
}
