/** Resolved token usage after the provider fills missing sides and clamps
 * cache/reasoning subsets. Shared by the chat provider, status bar, metrics
 * and status snapshot so the callback shape cannot drift. */

export type TokenSource = "reported" | "estimated";

export interface ResolvedChatUsage {
  routeId?: string;
  baseUrl?: string;
  serverName: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  inputTokenProvenance: TokenSource;
  outputTokenProvenance: TokenSource;
}

/** Usage accepted by persistent metrics. Unlike the live status snapshot,
 * persisted usage must always belong to a configured route. */
export type RecordedChatUsage = ResolvedChatUsage & {
  routeId: string;
  baseUrl: string;
};

export function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Cache is a subset of input; reasoning is a subset of output. Preserve an
 * explicit zero so callers can distinguish it from an absent/invalid count. */
export function subsetTokens(value: unknown, limit: number): number | undefined {
  const count = finiteNonNegative(value);
  if (count === undefined) return undefined;
  return Math.min(count, finiteNonNegative(limit) ?? 0);
}
