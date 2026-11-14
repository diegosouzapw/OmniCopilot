import { describe, expect, it } from "vitest";
import {
  REASONING_EFFORTS,
  buildEffortSchema,
  effortTiersFor,
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

  it("keeps max as its own tier", () => {
    expect(normalizeReasoningEffort("max")).toBe("max");
  });

  it("maps extra onto xhigh and ultra onto max", () => {
    expect(normalizeReasoningEffort("extra")).toBe("xhigh");
    expect(normalizeReasoningEffort("ultra")).toBe("max");
  });

  it("accepts a tier the model advertises even when it is not canonical", () => {
    expect(normalizeReasoningEffort("ultra", ["low", "high", "ultra"])).toBe("ultra");
    expect(normalizeReasoningEffort(" ULTRA ", ["ultra"])).toBe("ultra");
  });

  it("maps the off synonyms onto none", () => {
    expect(normalizeReasoningEffort("off")).toBe("none");
    expect(normalizeReasoningEffort("disabled")).toBe("none");
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

describe("effortTiersFor", () => {
  it("returns the tiers the model advertises", () => {
    expect(effortTiersFor({ capabilities: { effort_tiers: ["low", "high"] } })).toEqual(["low", "high"]);
  });

  it("falls back to the canonical list when none are advertised", () => {
    expect(effortTiersFor({})).toEqual([...REASONING_EFFORTS]);
    expect(effortTiersFor({ capabilities: { effort_tiers: [] } })).toEqual([...REASONING_EFFORTS]);
  });
});

describe("isReasoningModel", () => {
  it("accepts either capability flag — providers disagree on the name", () => {
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

describe("resolveReasoningEffort with the model picker", () => {
  it("prefers the picker choice in modelConfiguration over modelOptions and the default", () => {
    expect(
      resolveReasoningEffort({
        modelConfiguration: { reasoningEffort: "max" },
        modelOptions: { reasoning_effort: "low" },
        configuredDefault: "medium",
        modelIsReasoning: true,
      })
    ).toBe("max");
  });

  it("normalizes the picker choice against the tiers the model advertises", () => {
    expect(
      resolveReasoningEffort({
        modelConfiguration: { reasoningEffort: "ultra" },
        modelIsReasoning: true,
        modelTiers: ["high", "ultra"],
      })
    ).toBe("ultra");
  });

  it("falls through to modelOptions when the picker sent nothing usable", () => {
    expect(
      resolveReasoningEffort({
        modelConfiguration: { reasoningEffort: 3 },
        modelOptions: { effort: "high" },
        modelIsReasoning: true,
      })
    ).toBe("high");
  });
});

describe("buildEffortSchema", () => {
  const text = { title: "Thinking effort", label: (tier: string) => tier.toUpperCase() };

  it("describes an enum picker grouped next to the model", () => {
    const schema = buildEffortSchema(["low", "high"], text);
    expect(schema.properties.reasoningEffort).toEqual({
      type: "string",
      title: "Thinking effort",
      enum: ["low", "high"],
      enumItemLabels: ["LOW", "HIGH"],
      group: "navigation",
    });
  });

  it("omits the schema default when no default effort is configured", () => {
    const schema = buildEffortSchema(["low", "high"], text, "");
    expect("default" in schema.properties.reasoningEffort).toBe(false);
  });

  it("omits the schema default when the model does not offer the configured tier", () => {
    const schema = buildEffortSchema(["low", "high"], text, "max");
    expect("default" in schema.properties.reasoningEffort).toBe(false);
  });

  it("marks the configured default in the schema when the model offers it", () => {
    const schema = buildEffortSchema(["low", "medium", "high"], text, " High ");
    expect(schema.properties.reasoningEffort.default).toBe("high");
  });
});
