import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext, configValues, registeredTools, secretStore } from "./vscode.mock";
import { OmniRouteError } from "../src/client";
import { invalidateRouteCache } from "../src/routes";
import { createFixedTools, registerFixedTools } from "../src/tools";

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const route = (id: string) => ({ id, name: id.toUpperCase(), baseUrl: `http://${id}.test/v1` });
function client(models: Array<{ id: string; supported_endpoints: string[] }>, overrides: Record<string, unknown> = {}) {
  return {
    listModels: vi.fn().mockResolvedValue(models),
    search: vi.fn().mockResolvedValue({ data: [{ title: "result" }], extra: { preserved: true } }),
    rerank: vi.fn().mockResolvedValue({ results: [{ index: 0, relevance_score: 1 }], id: "rr-1" }),
    ...overrides,
  };
}

describe("fixed OmniRoute tools", () => {
  beforeEach(() => {
    registeredTools.length = 0;
    secretStore.clear();
    for (const key of Object.keys(configValues)) delete configValues[key];
    invalidateRouteCache();
    vi.clearAllMocks();
  });

  it("registers exactly two lifecycle disposables with the fixed names", () => {
    const context = createMockContext() as { subscriptions: unknown[] };
    registerFixedTools(context as never, log);
    expect(registeredTools.map((entry) => entry.name)).toEqual(["omniroute_search", "omniroute_rerank"]);
    expect(context.subscriptions).toHaveLength(2);
  });

  it("automatically selects a Search-capable route and maps model to provider with defaults", async () => {
    const clients = new Map([
      ["r1", client([{ id: "chat", supported_endpoints: ["/v1/responses"] }])],
      ["r2", client([{ id: "brave", supported_endpoints: ["POST /v1/search"] }])],
    ]);
    const tools = createFixedTools({ context: createMockContext() as never, log, loadRoutes: async () => [route("r1"), route("r2")], getClient: (r) => clients.get(r.id) as never });

    const result = await tools.search.invoke({ input: { query: "  latest VS Code  " }, toolInvocationToken: undefined }, token as never);
    expect(clients.get("r2")!.search).toHaveBeenCalledWith({ query: "latest VS Code", provider: "brave", max_results: 5, search_type: "web" }, expect.any(AbortSignal));
    expect(JSON.parse((result!.content[0] as { value: string }).value)).toEqual({ data: [{ title: "result" }], extra: { preserved: true } });
  });

  it("keeps routeId local and maps an explicit Search model override to provider", async () => {
    const c = client([{ id: "tavily", supported_endpoints: ["/search"] }]);
    const tools = createFixedTools({ context: createMockContext() as never, log, loadRoutes: async () => [route("r1")], getClient: () => c as never });
    await tools.search.invoke({ input: { query: "q", routeId: "r1", model: "tavily", max_results: 100, search_type: "news" }, toolInvocationToken: undefined }, token as never);
    expect(c.search).toHaveBeenCalledWith({ query: "q", provider: "tavily", max_results: 100, search_type: "news" }, expect.any(AbortSignal));
    expect(JSON.stringify(c.search.mock.calls[0][0])).not.toContain("routeId");
  });

  it("accepts exact Search boundaries and continues past an unavailable route catalog", async () => {
    const unavailable = client([], { listModels: vi.fn().mockRejectedValue(new Error("offline")) });
    const available = client([{ id: "search-provider", supported_endpoints: ["/search"] }]);
    const tools = createFixedTools({ context: createMockContext() as never, log, loadRoutes: async () => [route("r1"), route("r2")], getClient: (r) => (r.id === "r1" ? unavailable : available) as never });
    await tools.search.invoke({ input: { query: "x".repeat(500), max_results: 1 }, toolInvocationToken: undefined }, token as never);
    expect(available.search).toHaveBeenCalledWith(
      { query: "x".repeat(500), provider: "search-provider", max_results: 1, search_type: "web" },
      expect.any(AbortSignal)
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not inspect route "r1" for /search'));
  });

  it("selects and sends the required Rerank model while preserving optional fields", async () => {
    const c = client([{ id: "cohere/rerank-v3", supported_endpoints: ["https://x.test/v1/rerank"] }]);
    const tools = createFixedTools({ context: createMockContext() as never, log, loadRoutes: async () => [route("r1")], getClient: () => c as never });
    const result = await tools.rerank.invoke({ input: { query: " q ", documents: ["a", "b"], top_n: 1, return_documents: true }, toolInvocationToken: undefined }, token as never);
    expect(c.rerank).toHaveBeenCalledWith({ model: "cohere/rerank-v3", query: "q", documents: ["a", "b"], top_n: 1, return_documents: true }, expect.any(AbortSignal));
    expect(JSON.parse((result!.content[0] as { value: string }).value)).toEqual({ results: [{ index: 0, relevance_score: 1 }], id: "rr-1" });
  });

  it.each([
    [{ query: "" }, "query must be a non-empty string"],
    [{ query: "x".repeat(501) }, "query must be at most 500 characters"],
    [{ query: "q", max_results: 0 }, "max_results must be an integer between 1 and 100"],
    [{ query: "q", search_type: "images" }, "search_type must be either web or news"],
  ])("clearly rejects invalid Search input %j", async (input, message) => {
    const tools = createFixedTools({ context: createMockContext() as never, log, loadRoutes: async () => [], getClient: () => client([]) as never });
    await expect(tools.search.invoke({ input, toolInvocationToken: undefined } as never, token as never)).rejects.toThrow(message);
  });

  it.each([
    [{ query: "", documents: ["a"] }, "query must be a non-empty string"],
    [{ query: "q", documents: [] }, "documents must contain at least one string"],
    [{ query: "q", documents: ["a", 2] }, "documents must contain only strings"],
    [{ query: "q", documents: ["a"], top_n: 2 }, "top_n cannot exceed the number of documents"],
  ])("clearly rejects invalid Rerank input %j", async (input, message) => {
    const tools = createFixedTools({ context: createMockContext() as never, log, loadRoutes: async () => [], getClient: () => client([]) as never });
    await expect(tools.rerank.invoke({ input, toolInvocationToken: undefined } as never, token as never)).rejects.toThrow(message);
  });

  it("validates route and model overrides against exact endpoint capability", async () => {
    const c = client([{ id: "chat-only", supported_endpoints: ["/responses"] }]);
    const tools = createFixedTools({ context: createMockContext() as never, log, loadRoutes: async () => [route("r1")], getClient: () => c as never });
    await expect(tools.search.invoke({ input: { query: "q", routeId: "missing" }, toolInvocationToken: undefined }, token as never)).rejects.toThrow('Unknown OmniRoute routeId "missing"');
    await expect(tools.rerank.invoke({ input: { query: "q", documents: ["d"], model: "chat-only" }, toolInvocationToken: undefined }, token as never)).rejects.toThrow('Model override "chat-only" does not support /rerank');
  });

  it("fails over before a result only for transient errors", async () => {
    const first = client([{ id: "s1", supported_endpoints: ["/search"] }], { search: vi.fn().mockRejectedValue(new OmniRouteError("busy", 503)) });
    const second = client([{ id: "s2", supported_endpoints: ["/search"] }]);
    const tools = createFixedTools({ context: createMockContext() as never, log, loadRoutes: async () => [route("r1"), route("r2")], getClient: (r) => (r.id === "r1" ? first : second) as never });
    await tools.search.invoke({ input: { query: "q" }, toolInvocationToken: undefined }, token as never);
    expect(first.search).toHaveBeenCalledTimes(1);
    expect(second.search).toHaveBeenCalledTimes(1);

    first.search.mockRejectedValueOnce(new OmniRouteError("bad", 400));
    await expect(tools.search.invoke({ input: { query: "q" }, toolInvocationToken: undefined }, token as never)).rejects.toMatchObject({ status: 400 });
    expect(second.search).toHaveBeenCalledTimes(1);
  });

  it("caps discovery at ten routes and keeps concurrent invocations independent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const routes = Array.from({ length: 12 }, (_, i) => route(`r${i + 1}`));
    const clients = new Map(routes.map((r, i) => [r.id, client([{ id: `s${i}`, supported_endpoints: ["/search"] }], {
      search: vi.fn(async (body: { query: string }) => { calls.push(body.query); await gate; return { query: body.query }; }),
    })]));
    const tools = createFixedTools({ context: createMockContext() as never, log, loadRoutes: async () => routes, getClient: (r) => clients.get(r.id) as never });
    const p1 = tools.search.invoke({ input: { query: "one" }, toolInvocationToken: undefined }, token as never);
    const p2 = tools.search.invoke({ input: { query: "two" }, toolInvocationToken: undefined }, token as never);
    await vi.waitFor(() => expect(calls).toEqual(["one", "two"]));
    expect(clients.get("r11")!.listModels).not.toHaveBeenCalled();
    expect(clients.get("r12")!.listModels).not.toHaveBeenCalled();
    release();
    await expect(Promise.all([p1, p2])).resolves.toHaveLength(2);
  });

  it("reports cancellation immediately after a Search route finishes listModels", async () => {
    let checks = 0;
    const cancelledAfterList = {
      get isCancellationRequested() { return ++checks >= 2; },
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const c = client([{ id: "search-provider", supported_endpoints: ["/search"] }]);
    const tools = createFixedTools({
      context: createMockContext() as never,
      log,
      loadRoutes: async () => [route("r1")],
      getClient: () => c as never,
    });

    await expect(tools.search.invoke(
      { input: { query: "cancel me" }, toolInvocationToken: undefined },
      cancelledAfterList as never
    )).rejects.toThrow("The operation was cancelled");
    expect(c.search).not.toHaveBeenCalled();
  });

  it("reports cancellation after all Rerank discovery promises settle instead of no capability", async () => {
    let checks = 0;
    const cancelledAfterAll = {
      get isCancellationRequested() { return ++checks >= 5; },
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const noCapability = client([]);
    const tools = createFixedTools({
      context: createMockContext() as never,
      log,
      loadRoutes: async () => [route("r1"), route("r2")],
      getClient: () => noCapability as never,
    });

    await expect(tools.rerank.invoke(
      { input: { query: "q", documents: ["a"] }, toolInvocationToken: undefined },
      cancelledAfterAll as never
    )).rejects.toThrow("The operation was cancelled");
    expect(noCapability.rerank).not.toHaveBeenCalled();
  });
});
