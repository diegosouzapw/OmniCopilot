import { describe, expect, it } from "vitest";
import {
  REASONING_EFFORTS,
  isReasoningModel,
  normalizeReasoningEffort,
  resolveReasoningEffort,
} from "../src/reasoning";

describe("normalizeReasoningEffort", () => {
  it("accepts every canonical tier", () => {
    for (const tier of REASONING_EFFORTS) {
      expect(normalizeReasoningEffort(tier)).toBe(tier);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeReasoningEffort("  HIGH ")).toBe("high");
  });

  it("collapses the top-tier synonyms onto xhigh", () => {
    expect(normalizeReasoningEffort("max")).toBe("xhigh");
    expect(normalizeReasoningEffort("extra")).toBe("xhigh");
    expect(normalizeReasoningEffort("ultra")).toBe("xhigh");
  });

  it("maps OpenAI's 'minimal' onto low instead of forwarding it verbatim", () => {
    // `minimal` is not in OmniRoute's canonical set, so passing it through
    // would reach providers that reject it.
    expect(normalizeReasoningEffort("minimal")).toBe("low");
  });

  it("returns undefined for anything unrecognized, so the request stays untouched", () => {
    for (const value of ["", "   ", "turbo", "7", null, undefined, 3, {}, []]) {
      expect(normalizeReasoningEffort(value)).toBeUndefined();
    }
  });
});

describe("isReasoningModel", () => {
  it("accepts either capability flag ÔÇö providers disagree on the name", () => {
    expect(isReasoningModel({ capabilities: { reasoning: true } })).toBe(true);
    expect(isReasoningModel({ capabilities: { thinking: true } })).toBe(true);
  });

  it("is false when absent or explicitly false", () => {
    expect(isReasoningModel({})).toBe(false);
    expect(isReasoningModel({ capabilities: {} })).toBe(false);
    expect(isReasoningModel({ capabilities: { reasoning: false, thinking: false } })).toBe(false);
  });
});

describe("resolveReasoningEffort", () => {
  it("takes the editor's per-request value from any of the accepted shapes", () => {
    const shapes = [
      { reasoning_effort: "high" },
      { reasoningEffort: "high" },
      { reasoning: { effort: "high" } },
      { effort: "high" },
    ];
    for (const modelOptions of shapes) {
      expect(resolveReasoningEffort({ modelOptions, modelIsReasoning: true })).toBe("high");
    }
  });

  it("lets the editor's choice win over the configured default", () => {
    expect(
      resolveReasoningEffort({
        modelOptions: { reasoning_effort: "low" },
        configuredDefault: "high",
        modelIsReasoning: true,
      })
    ).toBe("low");
  });

  it("applies the configured default to reasoning-capable models", () => {
    expect(
      resolveReasoningEffort({ configuredDefault: "medium", modelIsReasoning: true })
    ).toBe("medium");
  });

  it("never applies the configured default to a model without thinking support", () => {
    // Sending reasoning_effort to a non-thinking model is ignored at best and a
    // 400 at worst, so the default must not leak onto the whole catalog.
    expect(
      resolveReasoningEffort({ configuredDefault: "high", modelIsReasoning: false })
    ).toBeUndefined();
  });

  it("still forwards an explicit request even when the catalog says non-reasoning", () => {
    // The catalog can be stale or incomplete; an explicit user choice is a
    // stronger signal than a missing capability flag.
    expect(
      resolveReasoningEffort({
        modelOptions: { reasoning_effort: "high" },
        modelIsReasoning: false,
      })
    ).toBe("high");
  });

  it("returns undefined when nothing is configured or requested", () => {
    expect(resolveReasoningEffort({ modelIsReasoning: true })).toBeUndefined();
    expect(
      resolveReasoningEffort({ modelOptions: {}, configuredDefault: "", modelIsReasoning: true })
    ).toBeUndefined();
  });

  it("ignores a garbage default instead of forwarding it", () => {
    expect(
      resolveReasoningEffort({ configuredDefault: "very-high", modelIsReasoning: true })
    ).toBeUndefined();
  });
});
