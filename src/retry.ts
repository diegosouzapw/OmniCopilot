import { OmniRouteRequestError } from "./client";

export interface RetryPolicy {
  /** Retries after the first attempt. */
  maxRetries: number;
  /** Longest single wait the extension is willing to sit through. */
  maxDelayMs: number;
  /** Longest total time since the request started, including the next wait. */
  totalBudgetMs: number;
  /** First backoff step when the server gave no hint; doubles on each retry. */
  baseDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  maxDelayMs: 30_000,
  totalBudgetMs: 60_000,
  baseDelayMs: 1_000,
};

/** HTTP statuses that mean "try again later" rather than "your request is wrong". */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Shortest wait ever returned, so a `Retry-After: 0` cannot turn into a busy loop. */
const MIN_DELAY_MS = 250;

/** Parse a `Retry-After` value — delay in seconds or an HTTP date — into
 * milliseconds. A date already in the past means no wait (0). Anything else
 * is "no hint" (undefined). */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now()
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Read the `(reset after 24s)` hint OmniRoute appends to upstream errors. */
export function retryDelayFromMessage(message: string): number | undefined {
  const match = /reset after (\d+)s/i.exec(message);
  return match ? Number(match[1]) * 1000 : undefined;
}

/** How long to wait before trying again, or null when the error should be
 * shown to the user instead. `retriesDone` counts the retries already made;
 * `elapsedMs` is the time since the request first started. */
export function nextRetryDelay(
  err: unknown,
  retriesDone: number,
  elapsedMs: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): number | null {
  if (!(err instanceof OmniRouteRequestError)) return null;
  const { status, network, retryAfterMs } = err.info;
  if (!network && !(status !== undefined && RETRYABLE_STATUS.has(status))) return null;
  if (retriesDone >= policy.maxRetries) return null;

  const wait = retryAfterMs ?? policy.baseDelayMs * 2 ** retriesDone;
  if (wait > policy.maxDelayMs) return null;
  if (elapsedMs + wait > policy.totalBudgetMs) return null;
  return Math.max(MIN_DELAY_MS, wait);
}
