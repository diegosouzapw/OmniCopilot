import { describe, expect, it, beforeEach } from "vitest";
import { MetricsTracker, fmtTokens } from "../src/metrics";
import { estimateTokens } from "../src/convert";
import type { Route } from "../src/routes";

function mockContext(initialMetrics?: unknown) {
  const store = new Map<string, unknown>();
  if (initialMetrics !== undefined) {
    store.set("omnicopilot.tokenMetrics.v1", initialMetrics);
  }
  return {
    globalState: {
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  } as unknown as ConstructorParameters<typeof MetricsTracker>[0];
}

describe("fmtTokens", () => {
  it("formats tokens into readable strings", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(500)).toBe("500");
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(2500000)).toBe("2.50M");
  });
});

describe("estimateTokens", () => {
  it("estimates tokens correctly for text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});

describe("MetricsTracker", () => {
  let context: ReturnType<typeof mockContext>;
  let tracker: MetricsTracker;

  beforeEach(() => {
    context = mockContext();
    tracker = new MetricsTracker(context);
  });

  it("hydrates omitted legacy counters before recording stalls and usage", async () => {
    const legacyMetrics = {
      sessionStartTime: 1_700_000_000_000,
      totalTokens: 30,
      totalRequests: 1,
      servers: {
        "route-1": {
          routeId: "route-1",
          name: "Legacy Server",
          baseUrl: "http://legacy.local/v1",
          online: true,
          totalTokens: 30,
          requestCount: 1,
        },
      },
    };
    tracker = new MetricsTracker(mockContext(legacyMetrics));

    const hydrated = tracker.getMetrics();
    expect(hydrated).toMatchObject({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 30,
      totalRequests: 1,
      totalStalls: 0,
    });
    expect(hydrated.servers["route-1"]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 30,
      requestCount: 1,
      successCount: 0,
      errorCount: 0,
      stallCount: 0,
    });

    await tracker.recordStall("route-1", "Legacy Server", "http://legacy.local/v1");
    await tracker.recordUsage({
      routeId: "route-1",
      serverName: "Legacy Server",
      baseUrl: "http://legacy.local/v1",
      modelName: "openai/gpt-4o",
      inputTokens: 12,
      outputTokens: 8,
      inputTokenProvenance: "reported",
      outputTokenProvenance: "reported",
    });

    const metrics = tracker.getMetrics();
    expect(metrics).toMatchObject({
      sessionStartTime: 1_700_000_000_000,
      totalInputTokens: 12,
      totalOutputTokens: 8,
      totalTokens: 50,
      totalRequests: 2,
      totalStalls: 1,
    });
    expect(metrics.servers["route-1"]).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 50,
      requestCount: 2,
      successCount: 1,
      errorCount: 0,
      stallCount: 1,
      lastUsedModel: "openai/gpt-4o",
    });
    expect([
      metrics.totalInputTokens,
      metrics.totalOutputTokens,
      metrics.totalTokens,
      metrics.totalRequests,
      metrics.totalStalls,
      metrics.servers["route-1"].inputTokens,
      metrics.servers["route-1"].outputTokens,
      metrics.servers["route-1"].totalTokens,
      metrics.servers["route-1"].requestCount,
      metrics.servers["route-1"].successCount,
      metrics.servers["route-1"].errorCount,
      metrics.servers["route-1"].stallCount,
    ].every(Number.isFinite)).toBe(true);
  });

  it("discards malformed containers and clamps invalid cumulative counters", () => {
    tracker = new MetricsTracker(mockContext({
      sessionStartTime: Number.POSITIVE_INFINITY,
      totalInputTokens: -1,
      totalOutputTokens: Number.NaN,
      totalTokens: 20,
      totalRequests: -4,
      totalStalls: Number.NEGATIVE_INFINITY,
      servers: [
        { routeId: "fake-array-route", totalTokens: 99 },
      ],
    }));

    const metrics = tracker.getMetrics();
    expect(metrics.totalInputTokens).toBe(0);
    expect(metrics.totalOutputTokens).toBe(0);
    expect(metrics.totalTokens).toBe(20);
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.totalStalls).toBe(0);
    expect(Number.isFinite(metrics.sessionStartTime)).toBe(true);
    expect(metrics.servers).toEqual({});
  });

  it("records usage and activity while preserving server names", async () => {
    await tracker.recordUsage({
      routeId: "route-1",
      serverName: "Primary Server",
      baseUrl: "http://localhost:8080",
      modelName: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
      inputTokenProvenance: "reported",
      outputTokenProvenance: "reported",
    });

    let metrics = tracker.getMetrics();
    expect(metrics.totalTokens).toBe(150);
    expect(metrics.totalInputTokens).toBe(100);
    expect(metrics.totalOutputTokens).toBe(50);
    expect(metrics.totalRequests).toBe(1);

    const server = metrics.servers["route-1"];
    expect(server).toBeDefined();
    expect(server.name).toBe("Primary Server");
    expect(server.inputTokens).toBe(100);
    expect(server.outputTokens).toBe(50);

    // Call recordActivity preserving name
    await tracker.recordActivity("route-1", "route-1", "http://localhost:8080", true);
    metrics = tracker.getMetrics();
    expect(metrics.servers["route-1"].name).toBe("Primary Server");
  });

  it("records cached and estimated tokens accurately", async () => {
    await tracker.recordUsage({
      routeId: "route-1",
      serverName: "Primary Server",
      baseUrl: "http://localhost:8080",
      modelName: "claude-sonnet-4-6",
      inputTokens: 200,
      outputTokens: 100,
      cachedTokens: 150,
      inputTokenProvenance: "reported",
      outputTokenProvenance: "reported",
    });
    await tracker.recordUsage({
      routeId: "route-1",
      serverName: "Primary Server",
      baseUrl: "http://localhost:8080",
      modelName: "fallback-model",
      inputTokens: 50,
      outputTokens: 25,
      inputTokenProvenance: "estimated",
      outputTokenProvenance: "estimated",
    });

    const metrics = tracker.getMetrics();
    expect(metrics.totalTokens).toBe(375);
    expect(metrics.totalInputTokens).toBe(250);
    expect(metrics.totalOutputTokens).toBe(125);
    expect(metrics.totalCachedTokens).toBe(150);
    expect(metrics.totalEstimatedTokens).toBe(75);
    expect(metrics.totalReasoningTokens).toBe(0);
    expect(metrics.inputTokenProvenance).toEqual({ reported: 200, estimated: 50, unknown: 0 });
    expect(metrics.outputTokenProvenance).toEqual({ reported: 100, estimated: 25, unknown: 0 });

    const server = metrics.servers["route-1"];
    expect(server.cachedTokens).toBe(150);
    expect(server.estimatedTokens).toBe(75);
    expect(server.inputTokenProvenance).toEqual({ reported: 200, estimated: 50, unknown: 0 });
    expect(server.outputTokenProvenance).toEqual({ reported: 100, estimated: 25, unknown: 0 });
  });


  it("records reasoning as an output subset with exact per-side provenance", async () => {
    await tracker.recordUsage({
      routeId: "route-1",
      serverName: "Primary Server",
      baseUrl: "http://localhost:8080",
      modelName: "reasoning-model",
      inputTokens: 120,
      outputTokens: 80,
      cachedTokens: 70,
      reasoningTokens: 30,
      inputTokenProvenance: "reported",
      outputTokenProvenance: "estimated",
    });

    const metrics = tracker.getMetrics();
    expect(metrics.totalTokens).toBe(200);
    expect(metrics.totalCachedTokens).toBe(70);
    expect(metrics.totalReasoningTokens).toBe(30);
    expect(metrics.inputTokenProvenance).toEqual({ reported: 120, estimated: 0, unknown: 0 });
    expect(metrics.outputTokenProvenance).toEqual({ reported: 0, estimated: 80, unknown: 0 });
    expect(metrics.servers["route-1"].reasoningTokens).toBe(30);
  });

  it("normalizes invalid primary counts without poisoning cumulative metrics", async () => {
    await tracker.recordUsage({
      routeId: "route-1",
      serverName: "Primary Server",
      baseUrl: "http://localhost:8080",
      modelName: "invalid-usage-model",
      inputTokens: Number.NaN,
      outputTokens: Number.POSITIVE_INFINITY,
      cachedTokens: -1,
      reasoningTokens: Number.NaN,
      inputTokenProvenance: "estimated",
      outputTokenProvenance: "estimated",
    });

    const metrics = tracker.getMetrics();
    expect(metrics.totalInputTokens).toBe(0);
    expect(metrics.totalOutputTokens).toBe(0);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.totalCachedTokens).toBe(0);
    expect(metrics.totalReasoningTokens).toBe(0);
    expect(Object.values(metrics.servers["route-1"]).filter((value) => typeof value === "number").every(Number.isFinite)).toBe(true);
  });

  it("clamps cached tokens to input and reasoning tokens to output", async () => {
    await tracker.recordUsage({
      routeId: "route-1",
      serverName: "Primary Server",
      baseUrl: "http://localhost:8080",
      modelName: "bounded-subsets-model",
      inputTokens: 10,
      outputTokens: 4,
      cachedTokens: 100,
      reasoningTokens: 100,
      inputTokenProvenance: "reported",
      outputTokenProvenance: "reported",
    });

    const metrics = tracker.getMetrics();
    expect(metrics).toMatchObject({
      totalTokens: 14,
      totalCachedTokens: 10,
      totalReasoningTokens: 4,
    });
    expect(metrics.servers["route-1"]).toMatchObject({
      totalTokens: 14,
      cachedTokens: 10,
      reasoningTokens: 4,
    });
  });

  it("classifies unreconstructable legacy persisted tokens as unknown", () => {
    tracker = new MetricsTracker(mockContext({
      sessionStartTime: 1_700_000_000_000,
      totalInputTokens: 40,
      totalOutputTokens: 60,
      totalTokens: 100,
      totalRequests: 1,
      servers: {
        "route-1": {
          routeId: "route-1",
          name: "Legacy Server",
          baseUrl: "http://legacy.local/v1",
          inputTokens: 40,
          outputTokens: 60,
          totalTokens: 100,
          requestCount: 1,
        },
      },
    }));

    const metrics = tracker.getMetrics();
    expect(metrics.inputTokenProvenance).toEqual({ reported: 0, estimated: 0, unknown: 40 });
    expect(metrics.outputTokenProvenance).toEqual({ reported: 0, estimated: 0, unknown: 60 });
    expect(metrics.servers["route-1"].inputTokenProvenance).toEqual({
      reported: 0,
      estimated: 0,
      unknown: 40,
    });
    expect(metrics.servers["route-1"].outputTokenProvenance).toEqual({
      reported: 0,
      estimated: 0,
      unknown: 60,
    });
  });

  it("resets metrics correctly", async () => {
    await tracker.recordUsage({
      routeId: "route-1",
      serverName: "Primary Server",
      baseUrl: "http://localhost:8080",
      modelName: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
      inputTokenProvenance: "reported",
      outputTokenProvenance: "reported",
    });
    await tracker.resetMetrics();

    const metrics = tracker.getMetrics();
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.totalRequests).toBe(0);
    expect(Object.keys(metrics.servers)).toHaveLength(0);
  });

  it("generates suggestions for single server configuration", () => {
    const routes: Route[] = [{ id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080" }];
    const suggestions = tracker.generateSuggestions(routes, new Set(["route-1"]));

    expect(suggestions.some((s) => s.id === "single_route")).toBe(true);
  });

  it("opens the dashboard from the stream stalls suggestion", async () => {
    await tracker.recordStall("route-1", "Primary Server", "http://localhost:8080");

    const suggestion = tracker
      .generateSuggestions([], new Set())
      .find((candidate) => candidate.id === "stream_stalls");

    expect(suggestion).toMatchObject({
      id: "stream_stalls",
      actionLabel: "Check Server Health",
      actionCommand: "omnicopilot.openDashboard",
    });
  });
});
