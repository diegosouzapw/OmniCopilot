import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BASE_URL, OmniRouteClient, normalizeBaseUrl, serverRootUrl } from "../src/client";
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
});
