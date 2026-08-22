import { describe, expect, it } from "vitest";
import { pickFallbackCandidates, transportPlanForModel } from "../src/routes";
import type { CatalogEntry, CatalogModel } from "../src/routes";

/**
 * Unit tests for the PRODUCTION fallback planner (src/routes.ts).
 *
 * NOTE: test/fallback.test.ts covers the deprecated pickFallbackModels in
 * src/client.ts; the provider actually consumes pickFallbackCandidates, so
 * these tests pin down the real chain semantics, including the "full" mode.
 */

function cat(
  routeId: string,
  routeName: string,
  modelId: string,
  toolCalling?: boolean
): CatalogModel {
  return {
    entry: { routeId, routeName, modelId, prefixedId: `${routeName} · ${modelId}` },
    model: {
      id: modelId,
      ...(toolCalling === undefined ? {} : { capabilities: { tool_calling: toolCalling } }),
    },
  };
}

const primary: CatalogEntry = {
  routeId: "A",
  routeName: "Server A",
  modelId: "openai/gpt-4o",
  prefixedId: "Server A · openai/gpt-4o",
};

describe("pickFallbackCandidates (production fallback chain)", () => {
  it('mode "none" returns no candidates', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("B", "Server B", "openai/gpt-4o"),
      cat("B", "Server B", "kimi/k2"),
    ];
    expect(pickFallbackCandidates(primary, catalog, false, "none")).toEqual([]);
  });

  it('mode "sameModel" returns only the same modelId on other routes', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"), // primary — excluded
      cat("B", "Server B", "openai/gpt-4o"), // same model, other route ✓
      cat("A", "Server A", "openai/gpt-4o-mini"), // other model on same route ✗
      cat("B", "Server B", "kimi/k2"), // other family ✗
    ];
    expect(pickFallbackCandidates(primary, catalog, false, "sameModel")).toEqual([
      { routeId: "B", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it('mode "sameFamily" adds other models of the same family on the SAME route', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("B", "Server B", "openai/gpt-4o"),
      cat("A", "Server A", "openai/gpt-4o-mini"), // same route, same family ✓
      cat("A", "Server A", "anthropic/claude-3-5-sonnet"), // same route, other family ✗
      cat("B", "Server B", "kimi/k2"), // other route+family ✗
    ];
    expect(pickFallbackCandidates(primary, catalog, false, "sameFamily")).toEqual([
      { routeId: "B", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] },
      { routeId: "A", modelId: "openai/gpt-4o-mini", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it('mode "full" covers the entire compatible catalog: sameModel → sameFamily → anything', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"), // primary — always excluded
      cat("B", "Server B", "openai/gpt-4o"), // tier 1: same model, other route
      cat("A", "Server A", "openai/gpt-4o-mini"), // tier 2: same route+family
      cat("A", "Server A", "anthropic/claude-3-5-sonnet"), // tier 3: anything
      cat("B", "Server B", "kimi/k2"), // tier 3: anything
    ];
    expect(pickFallbackCandidates(primary, catalog, false, "full")).toEqual([
      { routeId: "B", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] },
      { routeId: "A", modelId: "openai/gpt-4o-mini", transportPlan: ["responses", "chatCompletions"] },
      { routeId: "A", modelId: "anthropic/claude-3-5-sonnet", transportPlan: ["responses", "chatCompletions"] },
      { routeId: "B", modelId: "kimi/k2", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it('mode "full" with needsTools=true keeps only tool-capable models (explicit false drops, absent = compatible)', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"), // primary
      cat("B", "Server B", "openai/gpt-4o", false), // explicit false → excluded
      cat("A", "Server A", "anthropic/claude-3-5-sonnet", false), // explicit false → excluded
      cat("B", "Server B", "kimi/k2", true), // supported ✓
      cat("C", "Server C", "mistral/mistral-7b"), // no capabilities field → treated as compatible ✓
    ];
    expect(pickFallbackCandidates(primary, catalog, true, "full")).toEqual([
      { routeId: "B", modelId: "kimi/k2", transportPlan: ["responses", "chatCompletions"] },
      { routeId: "C", modelId: "mistral/mistral-7b", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it("is capped at max candidates (default 4) and never duplicates prefixedIds", () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("B", "Server B", "openai/gpt-4o"),
      cat("C", "Server C", "openai/gpt-4o"),
      cat("D", "Server D", "openai/gpt-4o"),
      cat("E", "Server E", "openai/gpt-4o"),
      cat("A", "Server A", "kimi/k2"), // same prefixedId as primary? no — different model, valid
    ];
    const result = pickFallbackCandidates(primary, catalog, false, "full");
    expect(result).toHaveLength(4);
    expect(new Set(result.map((r) => `${r.routeId}\u0000${r.modelId}`)).size).toBe(4);
  });

  it("returns [] when the catalog only contains the primary", () => {
    expect(
      pickFallbackCandidates(primary, [cat("A", "Server A", "openai/gpt-4o")], false, "full")
    ).toEqual([]);
  });

  it("defaults to mode full when no mode is given (provider contract)", () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("B", "Server B", "kimi/k2"),
    ];
    expect(pickFallbackCandidates(primary, catalog, false)).toEqual([
      { routeId: "B", modelId: "kimi/k2", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });
});

describe("transportPlanForModel", () => {
  it.each([
    [undefined, ["responses", "chatCompletions"]],
    [[], ["responses", "chatCompletions"]],
    [["future/protocol"], ["responses", "chatCompletions"]],
    [["responses"], ["responses"]],
    [["responses", "chat/completions"], ["responses", "chatCompletions"]],
    [["responses", "messages"], ["responses", "messages"]],
    [["chat/completions"], ["chatCompletions"]],
    [["messages"], ["messages"]],
    [["completions"], []],
    [["search", "/messages/count_tokens"], []],
  ] as const)("derives %j as the exact pre-output plan %j", (supported_endpoints, expected) => {
    const source = supported_endpoints === undefined
      ? { id: "m" }
      : { id: "m", supported_endpoints: [...supported_endpoints] };
    expect(transportPlanForModel(source)).toEqual(expected);
  });
});