import { describe, expect, it } from "vitest";
import { describeModel } from "../src/modelInfo";

const cfg = { maxOutputTokens: 16_384, defaultContextLength: 128_000 };

describe("describeModel", () => {
  it("reads max_output_tokens and name, the fields OmniRoute sends", () => {
    expect(
      describeModel({ id: "x/y", name: "Y Pro", context_length: 200_000, max_output_tokens: 8_192 }, cfg)
    ).toEqual({
      name: "Y Pro",
      contextLength: 200_000,
      maxOutputTokens: 8_192,
      maxInputTokens: 191_808,
      effortTiers: undefined,
    });
  });

  it("still honours max_completion_tokens and display_name", () => {
    const d = describeModel(
      { id: "x/y", display_name: "Shown", name: "Other", context_length: 100_000, max_completion_tokens: 4_000 },
      cfg
    );
    expect(d.name).toBe("Shown");
    expect(d.maxOutputTokens).toBe(4_000);
    expect(d.maxInputTokens).toBe(96_000);
  });

  it("falls back to the id when no name is sent", () => {
    expect(describeModel({ id: "x/y", name: "  " }, cfg).name).toBe("x/y");
  });

  it("uses the default context length when the catalog omits it", () => {
    expect(describeModel({ id: "x/y" }, cfg).contextLength).toBe(128_000);
  });

  it("never reserves more output than the configured budget", () => {
    const d = describeModel({ id: "x/y", context_length: 200_000, max_output_tokens: 64_000 }, cfg);
    expect(d.maxOutputTokens).toBe(16_384);
    expect(d.maxInputTokens).toBe(183_616);
  });

  it("ignores a non-positive model output limit", () => {
    expect(describeModel({ id: "x/y", max_output_tokens: 0 }, cfg).maxOutputTokens).toBe(16_384);
    expect(describeModel({ id: "x/y", max_output_tokens: -5, max_completion_tokens: 2_000 }, cfg).maxOutputTokens).toBe(2_000);
  });

  it("never reserves more than half of a small context window", () => {
    const d = describeModel({ id: "tiny", context_length: 8_192 }, cfg);
    expect(d.maxOutputTokens).toBe(4_096);
    expect(d.maxInputTokens).toBe(4_096);
  });

  it("caps the input budget at max_input_tokens when the server sends a smaller one", () => {
    const d = describeModel(
      { id: "x/y", context_length: 200_000, max_output_tokens: 8_192, max_input_tokens: 100_000 },
      cfg
    );
    expect(d.maxInputTokens).toBe(100_000);
  });

  it("keeps at least 1024 input tokens", () => {
    expect(describeModel({ id: "x/y", context_length: 1_500 }, cfg).maxInputTokens).toBe(1_024);
    expect(describeModel({ id: "x/y", max_input_tokens: 10 }, cfg).maxInputTokens).toBe(1_024);
  });

  it("exposes the advertised effort tiers, without empty entries", () => {
    const d = describeModel(
      { id: "x/y", capabilities: { effort_tiers: ["low", "", "high", "max"] } },
      cfg
    );
    expect(d.effortTiers).toEqual(["low", "high", "max"]);
  });

  it("reports no tiers when none survive", () => {
    expect(describeModel({ id: "x/y", capabilities: { effort_tiers: ["", " "] } }, cfg).effortTiers).toBeUndefined();
    expect(describeModel({ id: "x/y", capabilities: { effort_tiers: [] } }, cfg).effortTiers).toBeUndefined();
  });
});
