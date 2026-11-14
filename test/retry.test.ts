import { describe, expect, it } from "vitest";
import { OmniRouteRequestError } from "../src/client";
import {
  DEFAULT_RETRY_POLICY,
  nextRetryDelay,
  parseRetryAfter,
  retryDelayFromMessage,
} from "../src/retry";

const http = (status: number, retryAfterMs?: number) =>
  new OmniRouteRequestError(`HTTP ${status}`, { status, retryAfterMs });
const network = () => new OmniRouteRequestError("fetch failed", { network: true });

describe("parseRetryAfter", () => {
  it("reads Retry-After in seconds and as an HTTP date", () => {
    expect(parseRetryAfter("24")).toBe(24_000);
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(parseRetryAfter("Sat, 14 Nov 2026 12:00:10 GMT", now)).toBe(10_000);
  });

  it("treats a date in the past as no wait and anything unreadable as no hint", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(parseRetryAfter("Sat, 14 Nov 2026 11:59:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe("retryDelayFromMessage", () => {
  it("reads the reset hint OmniRoute appends to upstream errors", () => {
    expect(retryDelayFromMessage("[x/y] [503]: busy (reset after 24s)")).toBe(24_000);
  });

  it("ignores case and returns undefined without a hint", () => {
    expect(retryDelayFromMessage("Quota will RESET AFTER 5S")).toBe(5_000);
    expect(retryDelayFromMessage("[503]: busy")).toBeUndefined();
  });
});

describe("nextRetryDelay", () => {
  it("waits for the time the server asks for", () => {
    expect(nextRetryDelay(http(429, 24_000), 0, 0)).toBe(24_000);
  });

  it("does not sit on a cooldown longer than the cap", () => {
    expect(nextRetryDelay(http(429, 120_000), 0, 0)).toBeNull();
  });

  it("backs off 1 s then 2 s on network errors without a hint", () => {
    expect(nextRetryDelay(network(), 0, 0)).toBe(1_000);
    expect(nextRetryDelay(network(), 1, 0)).toBe(2_000);
  });

  it("never waits less than 250 ms", () => {
    expect(nextRetryDelay(http(503, 0), 0, 0)).toBe(250);
    expect(nextRetryDelay(http(429, 40), 0, 0)).toBe(250);
  });

  it("stops after two retries", () => {
    expect(nextRetryDelay(http(503), 1, 0)).not.toBeNull();
    expect(nextRetryDelay(http(503), 2, 0)).toBeNull();
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(2);
  });

  it("stops when the total budget would be exceeded", () => {
    expect(nextRetryDelay(http(429, 10_000), 0, 50_000)).toBe(10_000);
    expect(nextRetryDelay(http(429, 10_000), 0, 50_001)).toBeNull();
  });

  it.each([408, 429, 500, 502, 503, 504])("retries HTTP %i", (status) => {
    expect(nextRetryDelay(http(status), 0, 0)).toBe(1_000);
  });

  it("never retries a 400, a 401 or an unknown error", () => {
    expect(nextRetryDelay(http(400), 0, 0)).toBeNull();
    expect(nextRetryDelay(http(401), 0, 0)).toBeNull();
    expect(nextRetryDelay(new OmniRouteRequestError("x", {}), 0, 0)).toBeNull();
    expect(nextRetryDelay(new Error("boom"), 0, 0)).toBeNull();
    expect(nextRetryDelay("boom", 0, 0)).toBeNull();
  });

  it("honours a custom policy", () => {
    const policy = { maxRetries: 1, maxDelayMs: 5_000, totalBudgetMs: 10_000, baseDelayMs: 500 };
    expect(nextRetryDelay(network(), 0, 0, policy)).toBe(500);
    expect(nextRetryDelay(network(), 1, 0, policy)).toBeNull();
    expect(nextRetryDelay(http(429, 6_000), 0, 0, policy)).toBeNull();
  });
});
