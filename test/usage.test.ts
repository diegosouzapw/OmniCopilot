import { describe, expect, it } from "vitest";
import {
  formatResetIn,
  formatUsd,
  percentLeft,
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
