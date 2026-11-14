/**
 * Client + shaping for OmniRoute's self-service usage endpoint
 * (`GET /api/usage/om-usage?format=json`), the server half of OmniCopilot #8.
 *
 * The shapes below mirror `UsageCommandJson` in the OmniRoute repo
 * (`src/lib/usage/internalUsageCommand.ts`). They are re-declared here rather
 * than imported because the extension ships standalone — keep the field names
 * aligned with the server when either side changes.
 */

import type { Translate } from "./diagnostics";

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
  usedPercentage?: number;
  /** A percentage for some providers, a currency balance or an absolute count
   * for others — never read it on its own without the rules in
   * `quotaRemainingPercent`. */
  remaining?: number;
  remainingPercentage?: number;
  unlimited?: boolean;
  currency?: string;
  displayName?: string;
  resetAt?: string | null;
}

export interface UsageSnapshot {
  connectionId: string;
  provider: string;
  plan?: unknown;
  quotas?: Record<string, UsageQuotaWindow>;
}

/** A quota window with everything the webview prints already resolved on the
 * host: the script does no arithmetic and no formatting of its own. */
export type UsageQuotaView = UsageQuotaWindow & {
  /** Width of the bar (0-100); null draws no bar. */
  percentLeft: number | null;
  /** Formatted amount left on a money quota ("$12.50", "12.5 EUR"), else null. */
  balance: string | null;
  unlimited: boolean;
  resetIn: string | null;
  /** What is left, localised: "$0.37 left", "62% left", "unlimited" or "—". */
  text: string;
  /** The server's `displayName` when it sends one, else the window key. */
  label: string;
};

export type UsageLimitView = UsageLimitStatus & {
  dailyPercentLeft: number | null;
  weeklyPercentLeft: number | null;
  dailyResetIn: string | null;
  weeklyResetIn: string | null;
  /** "$1.20 / $5.00 (76% left)"; the share only when it is known. */
  dailyText: string;
  weeklyText: string;
};

export type UsageSnapshotView = Omit<UsageSnapshot, "quotas"> & {
  quotas?: Record<string, UsageQuotaView>;
};

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
  | { kind: "ready"; personal: UsageLimitView | null; providers: UsageSnapshotView[] };

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

/** The countdown for a panel row, or null when there is nothing worth saying:
 * the reset time is unknown or has already passed. */
export function resetLabel(resetAtIso: string | null | undefined, now = Date.now()): string | null {
  const label = formatResetIn(resetAtIso, now);
  return label === "unknown" || label === "now" ? null : label;
}

/** Percent of the limit still available, for the personal USD rows. */
export function percentLeft(spent: number, limit: number | null): number | null {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - spent / limit) * 100)));
}

/** Fills `{0}`-style placeholders without translating: the default for tests. */
const untranslated: Translate = (source, ...args) =>
  source.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < args.length ? String(args[Number(index)]) : match
  );

/** "$1.20 / $5.00 (76% left)" for a personal limit row. */
function limitText(spent: number, limit: number | null, left: number | null, t: Translate): string {
  const share = left === null ? "" : ` (${t("{0}% left", left)})`;
  return `${formatUsd(spent)} / ${formatUsd(limit)}${share}`;
}

/** The text of a quota row: a money balance wins over `unlimited` and over a
 * percentage; otherwise unlimited, then a known percentage, then a dash. */
function quotaText(
  balance: string | null,
  unlimited: boolean,
  left: number | null,
  t: Translate
): string {
  if (balance !== null) return t("{0} left", balance);
  if (unlimited) return t("unlimited");
  if (left !== null) return t("{0}% left", left);
  return "—";
}

function quotaView(name: string, quota: UsageQuotaWindow, now: number, t: Translate): UsageQuotaView {
  const balance = quotaBalance(quota);
  const unlimited = quota.unlimited === true;
  const computed = quotaRemainingPercent(quota);
  // A row that reads "unlimited" draws no bar.
  const left = balance === null && unlimited ? null : computed;
  const displayName = typeof quota.displayName === "string" ? quota.displayName.trim() : "";
  return {
    ...quota,
    percentLeft: left,
    balance,
    unlimited,
    resetIn: resetLabel(quota.resetAt, now),
    text: quotaText(balance, unlimited, left, t),
    label: displayName || name,
  };
}

/** Resolve the raw response into the panel's three states. Centralises the
 * "older servers answer text" fallback and the providers/provider merge, and
 * every text the panel prints (`t` localises it). */
export function toUsageView(
  body: UsageResponse,
  now = Date.now(),
  t: Translate = untranslated
): UsageView {
  if (body.allowed === false) return { kind: "disabled", message: body.error?.message };
  const snapshots = Array.isArray(body.providers)
    ? body.providers
    : body.provider
      ? [body.provider]
      : [];
  const personal: UsageLimitView | null = body.personal
    ? (() => {
        const p = body.personal;
        const dailyPercentLeft = percentLeft(p.dailySpentUsd, p.dailyLimitUsd);
        const weeklyPercentLeft = percentLeft(p.weeklySpentUsd, p.weeklyLimitUsd);
        return {
          ...p,
          dailyPercentLeft,
          weeklyPercentLeft,
          dailyResetIn: resetLabel(p.dailyResetAtIso, now),
          weeklyResetIn: resetLabel(p.weeklyResetAtIso, now),
          dailyText: limitText(p.dailySpentUsd, p.dailyLimitUsd, dailyPercentLeft, t),
          weeklyText: limitText(p.weeklySpentUsd, p.weeklyLimitUsd, weeklyPercentLeft, t),
        };
      })()
    : null;
  const providers: UsageSnapshotView[] = snapshots.map((snapshot) => ({
    ...snapshot,
    quotas: snapshot.quotas
      ? Object.fromEntries(
          Object.entries(snapshot.quotas)
            // A window that is not an object is skipped rather than hiding the section.
            .filter(([, quota]) => typeof quota === "object" && quota !== null)
            .map(([name, quota]) => [name, quotaView(name, quota, now, t)])
        )
      : undefined,
  }));
  return { kind: "ready", personal, providers };
}

/** GET the usage endpoint. Throws `UsageUnsupportedError` when the server
 * answered text — an OmniRoute that predates ?format=json — so the caller
 * hides the section instead of surfacing a parse failure. */
export class UsageUnsupportedError extends Error {}

export async function fetchUsage(
  baseUrl: string,
  apiKey: string | undefined,
  t: Translate = untranslated,
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
    return toUsageView(body, Date.now(), t);
  } finally {
    clearTimeout(timer);
  }
}

/** Same coercion as the server's `toNumber`: finite numbers and numeric
 * strings count, everything else is "absent". */
function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

/** A window carrying a non-empty `currency` measures money, not a share. */
const isMoneyQuota = (q: UsageQuotaWindow): q is UsageQuotaWindow & { currency: string } =>
  typeof q.currency === "string" && q.currency.trim() !== "";

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

/** Percentage of a quota window still available, or null when unknowable.
 *
 * Mirrors the server's `getQuotaUsedPercent`
 * (OmniRoute `src/lib/usage/internalUsageCommand.ts`), in the same order, then
 * converts "used" to "left". The unit of `remaining` is not fixed — a
 * percentage, a currency balance or an absolute count depending on the
 * provider — so it only counts when it already sits between 0 and 100; so
 * does `used`. Anything else is null rather than a guess.
 *
 * One deliberate difference from the server: a window with a `currency` is a
 * money quota. Its text is the balance (`quotaBalance`); the percentage only
 * sizes a bar, and only when `total` is positive (from `used`/`total`, else from
 * `remainingPercentage`). Servers send `total: 0` with `remainingPercentage: 100`
 * for a prepaid balance, which says nothing about how much is left. */
export function quotaRemainingPercent(q: UsageQuotaWindow): number | null {
  if (isMoneyQuota(q)) {
    const total = toNumber(q.total);
    if (!Number.isFinite(total) || total <= 0) return null;
    const spent = toNumber(q.used);
    if (Number.isFinite(spent)) return Math.round(clampPercent(100 - (spent / total) * 100));
    const remainingPercentage = toNumber(q.remainingPercentage);
    return Number.isFinite(remainingPercentage) ? Math.round(clampPercent(remainingPercentage)) : null;
  }
  const used = ((): number | null => {
    const usedPercentage = toNumber(q.usedPercentage);
    if (Number.isFinite(usedPercentage)) return clampPercent(usedPercentage);

    const spent = toNumber(q.used);
    const total = toNumber(q.total);
    if (Number.isFinite(spent) && Number.isFinite(total) && total > 0) {
      return clampPercent((spent / total) * 100);
    }
    if (Number.isFinite(spent) && spent >= 0 && spent <= 100) return spent;

    const remainingPercentage = toNumber(q.remainingPercentage);
    if (Number.isFinite(remainingPercentage)) return clampPercent(100 - remainingPercentage);

    const remaining = toNumber(q.remaining);
    if (Number.isFinite(remaining) && remaining >= 0 && remaining <= 100) {
      return clampPercent(100 - remaining);
    }
    return null;
  })();
  return used === null ? null : Math.round(clampPercent(100 - used));
}

/** The amount left on a money quota, formatted for display: "$12.50" for USD,
 * "12.5 EUR" for anything else. Null for a window without a currency or
 * without a finite, non-negative `remaining`. */
export function quotaBalance(q: UsageQuotaWindow): string | null {
  if (!isMoneyQuota(q)) return null;
  const remaining = toNumber(q.remaining);
  if (!Number.isFinite(remaining) || remaining < 0) return null;
  const code = q.currency.trim().toUpperCase();
  if (code === "USD") return formatUsd(remaining);
  return `${Math.round(remaining * 100) / 100} ${code}`;
}

/** Mime type VS Code's Copilot Chat reads from a language-model response to
 * feed the Context Window widget. Without it the widget shows 0 tokens. */
export const USAGE_MIME_TYPE = "usage";

export interface TokenUsagePayload {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
}

/** Builds the payload to report once a response ends. Uses the server's numbers
 * when present; otherwise falls back to a ~4 chars/token estimate so the widget
 * is approximately right instead of stuck at 0. */
export function buildUsagePayload(
  usage: import("./types").StreamUsage | null,
  fallback: { promptChars: number; completionChars: number }
): { payload: TokenUsagePayload; estimated: boolean } {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const p = num(usage?.prompt_tokens) ?? num(usage?.input_tokens);
  const c = num(usage?.completion_tokens) ?? num(usage?.output_tokens);
  const prompt = p ?? Math.ceil(fallback.promptChars / 4);
  const completion = c ?? Math.ceil(fallback.completionChars / 4);
  return {
    estimated: p === null || c === null,
    payload: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: num(usage?.prompt_tokens_details?.cached_tokens) ?? 0 },
    },
  };
}
