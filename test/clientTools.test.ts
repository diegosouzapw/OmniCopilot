import { afterEach, describe, expect, it, vi } from "vitest";
import { OmniRouteClient, OmniRouteError } from "../src/client";

describe("OmniRouteClient fixed endpoint tools", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts Search with bearer auth and preserves the complete JSON response", async () => {
    const payload = { object: "search.results", data: [{ url: "https://example.test", score: 0.9 }], meta: { took_ms: 4 } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OmniRouteClient({ baseUrl: "http://route.test/v1", apiKey: " secret ", retry: { maxAttempts: 1 } });

    await expect(client.search({ query: "vscode", provider: "brave", max_results: 7, search_type: "news" }, new AbortController().signal))
      .resolves.toEqual(payload);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://route.test/v1/search");
    expect(init).toMatchObject({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer secret", "Content-Type": "application/json" }) });
    expect(JSON.parse(String(init.body))).toEqual({ query: "vscode", provider: "brave", max_results: 7, search_type: "news" });
  });

  it("posts Rerank with the complete v3.8.50 request contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"results":[{"index":1,"relevance_score":0.8}]}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OmniRouteClient({ baseUrl: "http://route.test/v1", retry: { maxAttempts: 1 } });

    await expect(client.rerank({ model: "cohere/rerank", query: "needle", documents: ["a", "b"], top_n: 1, return_documents: true }, new AbortController().signal))
      .resolves.toEqual({ results: [{ index: 1, relevance_score: 0.8 }] });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ model: "cohere/rerank", query: "needle", documents: ["a", "b"], top_n: 1, return_documents: true });
  });

  it("retries transient HTTP errors but not permanent errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OmniRouteClient({ baseUrl: "http://route.test/v1", retry: { maxAttempts: 2, baseMs: 0, maxMs: 0 } });
    await expect(client.search({ query: "q", max_results: 5, search_type: "web" }, new AbortController().signal)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockResolvedValue(new Response("bad input", { status: 400 }));
    await expect(client.search({ query: "q", max_results: 5, search_type: "web" }, new AbortController().signal))
      .rejects.toMatchObject({ status: 400, endpoint: "/search" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors caller cancellation and reports a bounded timeout", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OmniRouteClient({ baseUrl: "http://route.test/v1", retry: { maxAttempts: 1 } });
    const ctrl = new AbortController();
    const cancelled = client.search({ query: "q", max_results: 5, search_type: "web" }, ctrl.signal, 1000);
    ctrl.abort(new Error("cancelled by caller"));
    await expect(cancelled).rejects.toThrow("cancelled by caller");

    vi.useFakeTimers();
    const timedOut = client.rerank({ model: "m", query: "q", documents: ["d"] }, new AbortController().signal, 25);
    const timeoutExpectation = expect(timedOut).rejects.toEqual(
      expect.objectContaining<Partial<OmniRouteError>>({ endpoint: "/rerank", phase: "connect" })
    );
    await vi.advanceTimersByTimeAsync(25);
    await timeoutExpectation;
  });
});
