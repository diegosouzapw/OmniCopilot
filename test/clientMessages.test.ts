import { afterEach, describe, expect, it, vi } from "vitest";
import { OmniRouteClient, OmniRouteError } from "../src/client";
import type { ChatRequest, StreamEvent } from "../src/types";

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

async function collectMessages(client: OmniRouteClient, request?: ChatRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.streamModel(
    request ?? { model: "claude", messages: [{ role: "user", content: "hi" }], stream: true },
    new AbortController().signal,
    ["messages"]
  )) events.push(event);
  return events;
}

describe("OmniRouteClient Messages transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serializes system, text, images, tool calls, tool results, tools, required choice, and max_tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["data: {\"type\":\"message_stop\"}"]));
    vi.stubGlobal("fetch", fetchMock);
    const request: ChatRequest = {
      model: "anthropic/claude-sonnet",
      stream: true,
      messages: [
        { role: "system", content: "Be precise." },
        { role: "user", content: [
          { type: "text", text: "Inspect this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
        ] },
        { role: "assistant", content: "I will inspect it.", tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "inspect_image", arguments: "{\"detail\":\"high\"}" },
        }] },
        { role: "tool", content: "sharp edges", tool_call_id: "call_1" },
      ],
      tools: [{ type: "function", function: {
        name: "inspect_image",
        description: "Inspect an image",
        parameters: { type: "object", properties: { detail: { type: "string" } } },
      } }],
      tool_choice: "required",
      temperature: 0.2,
      max_tokens: 777,
    };

    await expect(collectMessages(new OmniRouteClient({ baseUrl: "http://x/v1", apiKey: " secret " }), request))
      .resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://x/v1/messages");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "anthropic/claude-sonnet",
      system: "Be precise.",
      messages: [
        { role: "user", content: [
          { type: "text", text: "Inspect this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
        ] },
        { role: "assistant", content: [
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "call_1", name: "inspect_image", input: { detail: "high" } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "sharp edges" }] },
      ],
      stream: true,
      tools: [{
        name: "inspect_image",
        description: "Inspect an image",
        input_schema: { type: "object", properties: { detail: { type: "string" } } },
      }],
      tool_choice: { type: "any" },
      temperature: 0.2,
      max_tokens: 777,
    });
  });

  it("uses a required max_tokens fallback and maps auto tool choice", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["data: {\"type\":\"message_stop\"}"]));
    vi.stubGlobal("fetch", fetchMock);
    await collectMessages(new OmniRouteClient({ baseUrl: "http://x/v1" }), {
      model: "claude",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      tool_choice: "auto",
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.max_tokens).toBe(4096);
    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("parses text_delta and fragmented tool input with the tool_use id and name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Mad"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"rid\\"}"}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"message_stop"}',
    ])));
    await expect(collectMessages(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "text", text: "Hello" },
      { kind: "toolCall", id: "toolu_1", name: "get_weather", args: '{"city":"Madrid"}' },
    ]);
  });

  it("keeps genuinely absent Messages tool input as an empty object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_absent","name":"run"}}',
      'data: {"type":"content_block_stop","index":0}',
    ])));
    await expect(collectMessages(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "toolCall", id: "toolu_absent", name: "run", args: "{}" },
    ]);
  });

  it("emits a completed Messages tool call with its valid initial object input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_initial","name":"run","input":{"limit":3}}}',
      'data: {"type":"content_block_stop","index":0}',
    ])));
    await expect(collectMessages(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "toolCall", id: "toolu_initial", name: "run", args: '{"limit":3}' },
    ]);
  });

  it.each([
    ["malformed", '{"city":'],
    ["array", '["Madrid"]'],
    ["scalar", '"Madrid"'],
  ])("throws a /messages protocol stream error for %s completed tool arguments without emitting a fabricated call", async (_label, args) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_bad","name":"weather","input":{}}}',
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } })}`,
      'data: {"type":"content_block_stop","index":0}',
    ])));
    const emitted: StreamEvent[] = [];
    const client = new OmniRouteClient({ baseUrl: "http://x/v1" });
    const error = await (async () => {
      for await (const event of client.streamModel(
        { model: "claude", messages: [{ role: "user", content: "hi" }], stream: true },
        new AbortController().signal,
        ["messages"]
      )) emitted.push(event);
    })().then(() => null, (reason: unknown) => reason);

    expect(emitted).toEqual([]);
    expect(error).toBeInstanceOf(OmniRouteError);
    expect(error).toMatchObject({ phase: "stream", endpoint: "/messages" });
    expect((error as OmniRouteError).message).toContain("tool arguments");
  });

  it("rejects an explicit null Messages tool input rather than treating it as absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_null","name":"run","input":null}}',
      'data: {"type":"content_block_stop","index":0}',
    ])));
    await expect(collectMessages(new OmniRouteClient({ baseUrl: "http://x/v1" }))).rejects.toMatchObject({
      phase: "stream",
      endpoint: "/messages",
    });
  });

  it("filters fragmented OmniRoute diagnostics before a Messages tool call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OmniRoute: got req, "}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"sending to providerAnswer"}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"run","input":{}}}',
      'data: {"type":"content_block_stop","index":1}',
    ])));
    await expect(collectMessages(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "text", text: "Answer" },
      { kind: "toolCall", id: "toolu_2", name: "run", args: "{}" },
    ]);
  });

  it("normalizes Messages HTTP errors with endpoint and status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ type: "error", error: { type: "not_found_error", message: "unknown model" } }),
      { status: 404 }
    )));
    const err = await collectMessages(new OmniRouteClient({ baseUrl: "http://x/v1", chatMaxAttempts: 1 }))
      .then(() => null, (error: unknown) => error);
    expect(err).toBeInstanceOf(OmniRouteError);
    expect((err as OmniRouteError).status).toBe(404);
    expect((err as OmniRouteError).phase).toBe("headers");
    expect((err as OmniRouteError).endpoint).toBe("/messages");
    expect((err as OmniRouteError).message).toContain("unknown model");
  });

  it("normalizes Messages stream errors and infers throttling status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Service overloaded"}}',
    ])));
    const err = await collectMessages(new OmniRouteClient({ baseUrl: "http://x/v1" }))
      .then(() => null, (error: unknown) => error);
    expect(err).toBeInstanceOf(OmniRouteError);
    expect((err as OmniRouteError).status).toBe(503);
    expect((err as OmniRouteError).phase).toBe("stream");
    expect((err as OmniRouteError).endpoint).toBe("/messages");
  });

  it("never protocol-falls back from Messages on endpoint incompatibility", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "route not found" } }),
      { status: 404 }
    ));
    vi.stubGlobal("fetch", fetchMock);
    await expect(collectMessages(new OmniRouteClient({ baseUrl: "http://x/v1", chatMaxAttempts: 1 })))
      .rejects.toThrow("route not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["http://x/v1/messages"]);
  });

  it("honors cancellation before starting a Messages request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));
    const client = new OmniRouteClient({ baseUrl: "http://x/v1" });
    await expect((async () => {
      for await (const event of client.streamModel(
        { model: "claude", messages: [{ role: "user", content: "hi" }], stream: true },
        ctrl.signal,
        ["messages"]
      )) void event;
    })()).rejects.toThrow("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the shared watchdog and reports the Messages endpoint for a silent stream", async () => {
    const never = new ReadableStream<Uint8Array>({ start() { /* intentionally silent */ } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(never, { status: 200 })));
    const err = await collectMessages(new OmniRouteClient({
      baseUrl: "http://x/v1",
      streamFirstByteTimeoutMs: 20,
      streamIdleTimeoutMs: 20,
    })).then(() => null, (error: unknown) => error);
    expect(err).toBeInstanceOf(OmniRouteError);
    expect((err as OmniRouteError).stall).toBe(true);
    expect((err as OmniRouteError).phase).toBe("stream");
    expect((err as OmniRouteError).endpoint).toBe("/messages");
    expect((err as OmniRouteError).message).toContain("did not start responding");
  });

  it("parses Messages usage events from message_start and message_delta", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":150,"cache_creation_input_tokens":20,"cache_read_input_tokens":80,"output_tokens":1}}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude says hi"}}',
          'data: {"type":"message_delta","usage":{"output_tokens":42}}',
          'data: {"type":"message_stop"}',
        ])
      )
    );

    const client = new OmniRouteClient({ baseUrl: "http://x/v1" });
    const events = await collectMessages(client);

    expect(events).toEqual([
      {
        kind: "usage",
        usage: {
          inputTokens: 150,
          outputTokens: 1,
          cachedTokens: 100,
        },
      },
      { kind: "text", text: "Claude says hi" },
      {
        kind: "usage",
        usage: {
          inputTokens: undefined,
          outputTokens: 42,
          cachedTokens: undefined,
        },
      },
    ]);
  });
});