import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_URL,
  OmniRouteClient,
  OmniRouteRequestError,
  normalizeBaseUrl,
  serverRootUrl,
} from "../src/client";
import type { StreamEvent } from "../src/types";

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(client: OmniRouteClient): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const ctrl = new AbortController();
  for await (const e of client.streamChat(
    { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
    ctrl.signal
  )) {
    events.push(e);
  }
  return events;
}

describe("OmniRouteClient.streamChat", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("yields text deltas from SSE chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}',
          'data: {"choices":[{"delta":{"content":"lo"}}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
    ]);
  });

  it("yields usage from a final chunk with empty choices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([
      { kind: "text", text: "ok" },
      { kind: "usage", usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
    ]);
  });

  it("yields usage when it rides on the finish_reason chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":407,"completion_tokens":169,"total_tokens":576}}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([
      { kind: "usage", usage: { prompt_tokens: 407, completion_tokens: 169, total_tokens: 576 } },
    ]);
  });

  it("reassembles fragmented tool calls and flushes on finish_reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"a\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([
      { kind: "toolCall", id: "c1", name: "read_file", args: '{"path":"a"}' },
    ]);
  });

  it("flushes pending tool calls when the stream ends without finish_reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"run","arguments":"{}"}}]}}]}',
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([{ kind: "toolCall", id: "c9", name: "run", args: "{}" }]);
  });

  it("throws with the upstream error message on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "no such model" } }), { status: 404 })
      )
    );
    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).rejects.toThrow(
      /HTTP 404.*no such model/
    );
  });

  it("surfaces in-stream error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse(['data: {"error":{"message":"rate limited"}}']))
    );
    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).rejects.toThrow(
      "rate limited"
    );
  });

  it("cancels the body of an attempt that ends on an in-stream error", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // The server sends the error and keeps the connection open.
        controller.enqueue(
          new TextEncoder().encode('data: {"error":{"message":"rate limited"}}\n')
        );
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    );
    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).rejects.toThrow(
      "rate limited"
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed keep-alive lines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          ": keep-alive",
          "data: not-json",
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([{ kind: "text", text: "ok" }]);
  });

  it("sends Authorization only when an API key is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    await collect(new OmniRouteClient({ baseUrl: "http://x/v1", apiKey: "sk-1" }));
    let headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-1");

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(sseResponse(["data: [DONE]"]));
    await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("OmniRouteClient.streamChat errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function failure(client: OmniRouteClient): Promise<OmniRouteRequestError> {
    try {
      await collect(client);
    } catch (err) {
      expect(err).toBeInstanceOf(OmniRouteRequestError);
      return err as OmniRouteRequestError;
    }
    throw new Error("expected the request to fail");
  }

  const client = () => new OmniRouteClient({ baseUrl: "http://x/v1" });
  const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  it("carries the status and Retry-After of a rejected request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ error: { message: "All credentials for model m are cooling down" } }, 429, {
          "Retry-After": "24",
        })
      )
    );
    const err = await failure(client());
    expect(err.info).toEqual({ status: 429, retryAfterMs: 24_000 });
    expect(err.message).toBe(
      "OmniRoute request failed (HTTP 429): All credentials for model m are cooling down"
    );
  });

  it("falls back to the reset hint in the body when there is no Retry-After header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ error: { message: "cooling down", code: "model_cooldown", reset_seconds: 7 } }, 429)
      )
    );
    expect((await failure(client())).info).toEqual({ status: 429, retryAfterMs: 7_000 });
  });

  it("reads retry_after_seconds and an ISO retry_after from the body", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: "busy", retry_after_seconds: 3 } }, 503)
    );
    expect((await failure(client())).info.retryAfterMs).toBe(3_000);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: "busy", retry_after: "2026-11-14T12:00:09Z" } }, 429)
    );
    expect((await failure(client())).info.retryAfterMs).toBe(9_000);
  });

  it("prefers the Retry-After header over the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ error: { message: "x", reset_seconds: 99 } }, 429, { "Retry-After": "2" })
      )
    );
    expect((await failure(client())).info.retryAfterMs).toBe(2_000);
  });

  it("has no retry hint on an error that carries none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: { message: "no such model" } }, 404))
    );
    expect((await failure(client())).info).toEqual({ status: 404, retryAfterMs: undefined });
  });

  it("carries the status and reset hint of an error that arrives inside the stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse(['data: {"error":{"message":"[x/y] [503]: busy (reset after 24s)"}}'])
      )
    );
    const err = await failure(client());
    expect(err.info).toEqual({ status: 503, retryAfterMs: 24_000 });
    expect(err.message).toBe("[x/y] [503]: busy (reset after 24s)");
  });

  it("prefers the fields of an in-stream error over its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"error":{"message":"[503]: busy (reset after 24s)","status":429,"retry_after_seconds":3}}',
        ])
      )
    );
    expect((await failure(client())).info).toEqual({ status: 429, retryAfterMs: 3_000 });
  });

  it("reads the status of an in-stream error from status_code or a numeric code", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse(['data: {"error":{"message":"x","status_code":502}}'])
    );
    expect((await failure(client())).info.status).toBe(502);
    fetchMock.mockResolvedValueOnce(sseResponse(['data: {"error":{"message":"x","code":504}}']));
    expect((await failure(client())).info.status).toBe(504);
    // a symbolic code is not a status
    fetchMock.mockResolvedValueOnce(
      sseResponse(['data: {"error":{"message":"x","code":"model_cooldown"}}'])
    );
    expect((await failure(client())).info.status).toBeUndefined();
  });

  it("reads the reset hint OmniRoute puts in an in-stream error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse(['data: {"error":{"message":"cooling down","reset_seconds":5}}'])
      )
    );
    expect((await failure(client())).info.retryAfterMs).toBe(5_000);
  });

  it("marks a failed fetch as a network error and keeps the cause", async () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:20128");
    const failed = new TypeError("fetch failed", { cause });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failed));
    const err = await failure(client());
    expect(err.info).toEqual({ network: true });
    expect(err.cause).toBe(failed);
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("lets an aborted request propagate untouched", async () => {
    const aborted = new DOMException("This operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));
    await expect(collect(client())).rejects.toBe(aborted);
  });

  it("keeps a tool call that arrives without an id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"run","arguments":"{}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(client());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "toolCall", name: "run", args: "{}" });
    expect((events[0] as { id: string }).id).toMatch(/^call_[0-9a-f]{8}$/);
  });

  it("still drops a fragment that never got a name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"arguments":"{}"}}]}}]}',
          "data: [DONE]",
        ])
      )
    );
    expect(await collect(client())).toEqual([]);
  });
});

describe("normalizeBaseUrl / serverRootUrl", () => {
  it("appends /v1 to a bare server root (the new default shape)", () => {
    expect(normalizeBaseUrl("http://localhost:20128")).toBe("http://localhost:20128/v1");
  });

  it("does not double /v1 when the user pasted it (older stored settings)", () => {
    expect(normalizeBaseUrl("http://localhost:20128/v1")).toBe("http://localhost:20128/v1");
    expect(normalizeBaseUrl("http://localhost:20128/v1/")).toBe("http://localhost:20128/v1");
  });

  it("adds a scheme and trims trailing slashes", () => {
    expect(normalizeBaseUrl("192.168.0.17:20128//")).toBe("http://192.168.0.17:20128/v1");
  });

  it("falls back to the default server root when empty", () => {
    expect(normalizeBaseUrl("  ")).toBe(`${DEFAULT_BASE_URL}/v1`);
  });

  it("serverRootUrl strips /v1 back off for the dashboard and CLI bridge", () => {
    expect(serverRootUrl("http://192.168.0.17:20128/v1")).toBe("http://192.168.0.17:20128");
    expect(serverRootUrl("http://192.168.0.17:20128")).toBe("http://192.168.0.17:20128");
  });
});

describe("OmniRouteClient.listModels", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for one id per model (?prefix=alias) so dual-mode mirrors never reach the picker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: "list", data: [{ id: "a" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await new OmniRouteClient({ baseUrl: "http://x" }).listModels();

    expect(fetchMock.mock.calls[0][0]).toBe("http://x/v1/models?prefix=alias");
    expect(models.map((m) => m.id)).toEqual(["a"]);
  });

  it("throws with the status when the catalog call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    await expect(new OmniRouteClient({ baseUrl: "http://x" }).listModels()).rejects.toThrow("401");
  });

  it("reports a rejected catalog call as a request error with its status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    const err = await new OmniRouteClient({ baseUrl: "http://x" }).listModels().catch((e) => e);
    expect(err).toBeInstanceOf(OmniRouteRequestError);
    expect(err.info).toEqual({ status: 401 });
  });

  it("marks an unreachable server as a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))
    );
    const err = await new OmniRouteClient({ baseUrl: "http://x" }).listModels().catch((e) => e);
    expect(err).toBeInstanceOf(OmniRouteRequestError);
    expect(err.info).toEqual({ network: true });
  });

  it("gives up by itself after 15 seconds and calls that a network error", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () =>
                reject(new DOMException("This operation was aborted", "AbortError"))
              );
            })
        )
      );
      const pending = new OmniRouteClient({ baseUrl: "http://x" })
        .listModels()
        .catch((e) => e as OmniRouteRequestError);
      await vi.advanceTimersByTimeAsync(14_999);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const err = await pending;
      expect(err).toBeInstanceOf(OmniRouteRequestError);
      expect(err.info).toEqual({ network: true });
      expect(err.message).toContain("15");
    } finally {
      vi.useRealTimers();
    }
  });
});
