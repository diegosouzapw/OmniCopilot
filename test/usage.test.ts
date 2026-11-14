import { describe, expect, it } from "vitest";
import {
  buildUsagePayload,
  formatResetIn,
  formatUsd,
  percentLeft,
  quotaRemainingPercent,
  resetLabel,
  toUsageView,
} from "../src/usage";
import type { UsageResponse } from "../src/usage";

describe("toUsageView", () => {
  it("maps a refusal to the disabled state, carrying the reason", () => {
    const body: UsageResponse = { allowed: false, error: { message: "no" } };
    expect(toUsageView(body)).toEqual({ kind: "disabled", message: "no" });
  });

  it("reads providers[] when the server has the per-connection array", () => {
    const body: UsageResponse = {
      allowed: true,
      personal: null,
      provider: { connectionId: "c1", provider: "claude" },
      providers: [
        { connectionId: "c1", provider: "claude" },
        { connectionId: "c2", provider: "codex" },
      ],
    };
    const view = toUsageView(body);
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") expect(view.providers).toHaveLength(2);
  });

  it("falls back to the single provider on a server that predates providers[]", () => {
    // OmniRoute #11190 without #11192: only the selected snapshot is present.
    const body: UsageResponse = {
      allowed: true,
      personal: null,
      provider: { connectionId: "c1", provider: "claude" },
    };
    const view = toUsageView(body);
    if (view.kind === "ready") {
      expect(view.providers.map((p) => p.provider)).toEqual(["claude"]);
    } else {
      expect.unreachable();
    }
  });

  it("yields an empty providers list (not a refusal) when nothing is cached", () => {
    // Distinct from disabled: the key may ask, the server just has nothing yet.
    const view = toUsageView({ allowed: true, personal: null, provider: null });
    expect(view).toEqual({ kind: "ready", personal: null, providers: [] });
  });

  it("prepares personal and provider reset labels for the panel", () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    const view = toUsageView(
      {
        allowed: true,
        personal: {
          enabled: true,
          dailyLimitUsd: 10,
          weeklyLimitUsd: 50,
          dailySpentUsd: 2,
          weeklySpentUsd: 8,
          dailyResetAtIso: "2026-08-19T15:12:00Z",
          weeklyResetAtIso: "2026-08-21T16:00:00Z",
          dailyExceeded: false,
          weeklyExceeded: false,
        },
        provider: null,
        providers: [
          {
            connectionId: "c1",
            provider: "codex",
            quotas: {
              primary: { remaining: 75, resetAt: "2026-08-19T12:30:00Z" },
              secondary: { remaining: 100 },
            },
          },
        ],
      },
      now
    );

    expect(view.kind).toBe("ready");
    if (view.kind === "ready") {
      expect(view.personal?.dailyResetIn).toBe("3h 12m");
      expect(view.personal?.weeklyResetIn).toBe("2d 4h");
      expect(view.providers[0]?.quotas?.primary?.resetIn).toBe("30m");
      expect(view.providers[0]?.quotas?.secondary?.resetIn).toBeNull();
    }
  });

  it("precomputes percentages, the unlimited flag and reset labels for the panel", () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    const view = toUsageView(
      {
        allowed: true,
        personal: {
          enabled: true,
          dailyLimitUsd: 10,
          weeklyLimitUsd: null,
          dailySpentUsd: 2.5,
          weeklySpentUsd: 8,
          dailyResetAtIso: "2026-08-19T11:00:00Z", // already past
          weeklyResetAtIso: null,
          dailyExceeded: false,
          weeklyExceeded: false,
        },
        provider: null,
        providers: [
          {
            connectionId: "c1",
            provider: "mixed",
            quotas: {
              session: { usedPercentage: 30, resetAt: "2026-08-19T12:30:00Z" },
              balance: { remaining: 250, currency: "USD" },
              plan: { unlimited: true },
              count: { used: 1500 },
            },
          },
        ],
      },
      now
    );

    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.personal).toMatchObject({
      dailyPercentLeft: 75,
      weeklyPercentLeft: null,
      dailyResetIn: null,
      weeklyResetIn: null,
    });
    const quotas = view.providers[0]?.quotas ?? {};
    expect(quotas.session).toMatchObject({ percentLeft: 70, unlimited: false, resetIn: "30m" });
    expect(quotas.balance).toMatchObject({ percentLeft: null, unlimited: false, resetIn: null });
    expect(quotas.plan).toMatchObject({ percentLeft: null, unlimited: true, resetIn: null });
    expect(quotas.count?.percentLeft).toBeNull();
  });
});

describe("formatters", () => {
  it("formatUsd renders USD and em-dash for non-numbers", () => {
    expect(formatUsd(1.25)).toBe("$1.25");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
  });

  it("percentLeft clamps into 0–100 and is null without a limit", () => {
    expect(percentLeft(1, 4)).toBe(75);
    expect(percentLeft(10, 4)).toBe(0); // overspent never goes negative
    expect(percentLeft(0, 4)).toBe(100);
    expect(percentLeft(1, null)).toBeNull();
  });

  it("formatResetIn mirrors the server's phrasing", () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    expect(formatResetIn("2026-08-21T16:00:00Z", now)).toBe("2d 4h");
    expect(formatResetIn("2026-08-19T15:12:00Z", now)).toBe("3h 12m");
    expect(formatResetIn("2026-08-19T12:30:00Z", now)).toBe("30m");
    expect(formatResetIn(null, now)).toBe("unknown");
    expect(formatResetIn("not-a-date", now)).toBe("unknown");
    expect(formatResetIn("2026-08-19T11:00:00Z", now)).toBe("now"); // already past
  });
});

describe("quotaRemainingPercent", () => {
  it("resolves the remaining percentage in the server's order", () => {
    expect(quotaRemainingPercent({ usedPercentage: 30, used: 1, total: 2 })).toBe(70);
    expect(quotaRemainingPercent({ used: 25, total: 100 })).toBe(75);
    expect(quotaRemainingPercent({ used: 40 })).toBe(60);
    expect(quotaRemainingPercent({ remainingPercentage: 42 })).toBe(42);
    expect(quotaRemainingPercent({ remaining: 60 })).toBe(60);
  });

  it("lets used/total and a small `used` win over remainingPercentage and remaining", () => {
    expect(quotaRemainingPercent({ remainingPercentage: 42, used: 1, total: 10, remaining: 7 })).toBe(90);
    expect(quotaRemainingPercent({ used: 5, total: 0 })).toBe(95); // total unusable, used read as a percentage
    expect(quotaRemainingPercent({ remainingPercentage: 42, remaining: 7 })).toBe(42);
  });

  it("does not read a balance or an absolute count as a percentage", () => {
    expect(quotaRemainingPercent({ remaining: 250 })).toBeNull();
    expect(quotaRemainingPercent({ used: 1500 })).toBeNull();
    expect(quotaRemainingPercent({ used: -3 })).toBeNull();
    expect(quotaRemainingPercent({ remaining: -1 })).toBeNull();
    expect(quotaRemainingPercent({})).toBeNull();
  });

  it("clamps to 0-100 and rounds", () => {
    expect(quotaRemainingPercent({ used: 150, total: 100 })).toBe(0);
    expect(quotaRemainingPercent({ usedPercentage: 130 })).toBe(0);
    expect(quotaRemainingPercent({ usedPercentage: -5 })).toBe(100);
    expect(quotaRemainingPercent({ remainingPercentage: 130 })).toBe(100);
    expect(quotaRemainingPercent({ used: 1, total: 3 })).toBe(67);
  });

  it("accepts numeric strings the way the server does and ignores other values", () => {
    const loose = (q: object) => q as Parameters<typeof quotaRemainingPercent>[0];
    expect(quotaRemainingPercent(loose({ usedPercentage: "20" }))).toBe(80);
    expect(quotaRemainingPercent(loose({ used: "1", total: "4" }))).toBe(75);
    expect(quotaRemainingPercent(loose({ usedPercentage: "abc", remaining: 30 }))).toBe(30);
    expect(quotaRemainingPercent(loose({ usedPercentage: "  " }))).toBeNull();
  });
});

describe("resetLabel", () => {
  const now = Date.parse("2026-08-19T12:00:00Z");

  it("returns the formatted countdown for a future reset", () => {
    expect(resetLabel("2026-08-21T16:00:00Z", now)).toBe("2d 4h");
    expect(resetLabel("2026-08-19T12:30:00Z", now)).toBe("30m");
  });

  it("drops the label when the time is unknown or already past", () => {
    expect(resetLabel(null, now)).toBeNull();
    expect(resetLabel(undefined, now)).toBeNull();
    expect(resetLabel("", now)).toBeNull();
    expect(resetLabel("not-a-date", now)).toBeNull();
    expect(resetLabel("2026-08-19T11:00:00Z", now)).toBeNull();
  });
});

describe("buildUsagePayload", () => {
  const fb = { promptChars: 400, completionChars: 80 };

  it("uses the server's numbers when present", () => {
    const r = buildUsagePayload(
      { prompt_tokens: 407, completion_tokens: 169, prompt_tokens_details: { cached_tokens: 5 } },
      fb
    );
    expect(r.estimated).toBe(false);
    expect(r.payload).toEqual({
      prompt_tokens: 407,
      completion_tokens: 169,
      total_tokens: 576,
      prompt_tokens_details: { cached_tokens: 5 },
    });
  });

  it("accepts input_tokens/output_tokens naming", () => {
    const r = buildUsagePayload({ input_tokens: 10, output_tokens: 4 }, fb);
    expect(r.payload.total_tokens).toBe(14);
    expect(r.estimated).toBe(false);
  });

  it("falls back to ~4 chars/token and flags it as estimated", () => {
    const r = buildUsagePayload(null, fb);
    expect(r.estimated).toBe(true);
    expect(r.payload).toMatchObject({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  });
});
