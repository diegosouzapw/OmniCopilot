import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_URL,
  EncryptedReasoningFilter,
  OmniRouteClient,
  OmniRouteError,
  describeFetchError,
  isThrottleError,
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

function unterminatedSseResponse(line: string): Response {
  return new Response(new TextEncoder().encode(line), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function coalescedSseResponse(payload: string): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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

async function collectModel(client: OmniRouteClient): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.streamModel(
    { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
    new AbortController().signal,
    ["responses", "chatCompletions"]
  )) events.push(event);
  return events;
}

describe("OmniRouteClient.streamModel Responses transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses text and assembled function calls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"response.output_text.delta","delta":"Hi"}',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"weather","arguments":""}}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\\"city\\":"}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"\\"Madrid\\"}"}',
      'data: {"type":"response.output_item.done","item_id":"item-1"}',
    ])));
    await expect(collectModel(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "text", text: "Hi" },
      { kind: "toolCall", id: "call-1", name: "weather", args: '{"city":"Madrid"}' },
    ]);
  });

  it("preserves filtered text before a following tool call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"response.output_text.delta","delta":"OmniRoute: got req, sending to providerAnswer"}',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"run","arguments":"{}"}}',
    ])));
    await expect(collectModel(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "text", text: "Answer" },
      { kind: "toolCall", id: "call-1", name: "run", args: "{}" },
    ]);
  });

  it("parses a final Responses event without a trailing newline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unterminatedSseResponse(
      'data: {"type":"response.output_text.delta","delta":"final"}'
    )));
    await expect(collectModel(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "text", text: "final" },
    ]);
  });

  it("uses the call id and final function arguments without duplicating deltas", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"weather","arguments":""}}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\\"city\\":\\"Mad"}',
      'data: {"type":"response.function_call_arguments.done","item_id":"item-1","arguments":"{\\"city\\":\\"Madrid\\"}"}',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"weather","arguments":"{\\"city\\":\\"Madrid\\"}"}}',
    ])));
    await expect(collectModel(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "toolCall", id: "call-1", name: "weather", args: '{"city":"Madrid"}' },
    ]);
  });

  it("filters a fragmented encrypted reasoning notice from output text while preserving adjacent text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"response.output_text.delta","delta":"Before. Codex is reasoning, but upstream "}',
      'data: {"type":"response.output_text.delta","delta":"Responses API exposed this reasoning block only as encrypted private reasoning. "}',
      'data: {"type":"response.output_text.delta","delta":"OmniRoute cannot recover plaintext. After."}',
    ])));
    await expect(collectModel(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "text", text: "Before. " },
      { kind: "text", text: " After." },
    ]);
  });

  it("filters fragmented OmniRoute request diagnostics from output text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"response.output_text.delta","delta":"OmniRoute: got req, "}',
      'data: {"type":"response.output_text.delta","delta":"sending to providerAnswer"}',
    ])));
    await expect(collectModel(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "text", text: "Answer" },
    ]);
  });

  it("filters the diagnostic variants observed in chat", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"response.output_text.delta","delta":"OmniRoute: got request, sending to provider"}',
      'data: {"type":"response.output_text.delta","delta":"Codex is reasoning, but the upstream Responses API exposed this reasoning block only as encrypted private reasoning. "}',
      'data: {"type":"response.output_text.delta","delta":"OmniRoute cannot recover the plaintext.Answer"}',
    ])));
    await expect(collectModel(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "text", text: "Answer" },
    ]);
  });

  it("does not expose Responses reasoning summaries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"response.reasoning_summary_text.delta","delta":"Analyzing implementation"}',
      'data: {"type":"response.output_text.delta","delta":"Answer"}',
    ])));
    await expect(collectModel(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "text", text: "Answer" },
    ]);
  });

  it("falls back once on pre-output endpoint incompatibility", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"Not found"}}', { status: 404 }))
      .mockResolvedValueOnce(sseResponse(['data: {"choices":[{"delta":{"content":"fallback"}}]}', "data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(collectModel(new OmniRouteClient({ baseUrl: "http://x/v1", chatMaxAttempts: 1 })))
      .resolves.toEqual([{ kind: "text", text: "fallback" }]);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["http://x/v1/responses", "http://x/v1/chat/completions"]);
  });

  it("uses the metadata-derived Responses then Messages plan without trying Chat", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"Not found"}}', { status: 404 }))
      .mockResolvedValueOnce(sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"messages fallback"}}',
      ]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OmniRouteClient({ baseUrl: "http://x/v1", chatMaxAttempts: 1 });
    const events: StreamEvent[] = [];
    for await (const event of client.streamModel(
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
      new AbortController().signal,
      ["responses", "messages"]
    )) events.push(event);
    expect(events).toEqual([{ kind: "text", text: "messages fallback" }]);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://x/v1/responses",
      "http://x/v1/messages",
    ]);
  });

  it("does not switch an explicit Responses-only plan on incompatibility", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":{"message":"Not found"}}', { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OmniRouteClient({ baseUrl: "http://x/v1", chatMaxAttempts: 1 });
    const run = async () => {
      for await (const _event of client.streamModel(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
        new AbortController().signal,
        ["responses"]
      )) { /* no output expected */ }
    };
    await expect(run()).rejects.toThrow("Not found");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["http://x/v1/responses"]);
  });

  it.each([429, 503])("does not protocol-switch on HTTP %s", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("failed", { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(collectModel(new OmniRouteClient({ baseUrl: "http://x/v1", chatMaxAttempts: 1 }))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not protocol-switch after visible output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      'data: {"type":"error","error":{"message":"[404]: route not found"}}',
    ]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(collectModel(new OmniRouteClient({ baseUrl: "http://x/v1", chatMaxAttempts: 1 }))).rejects.toThrow("route not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

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

  it("parses a final Chat event without a trailing newline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unterminatedSseResponse(
      'data: {"choices":[{"delta":{"content":"final"}}]}'
    )));
    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "text", text: "final" },
    ]);
  });

  it("drains a coalesced chunk larger than 2 MiB when it contains short newline-delimited SSE records", async () => {
    const progressRecord = 'data: {"choices":[{"delta":{}}]}\n';
    const coalesced = `${progressRecord.repeat(70_000)}data: {"choices":[{"delta":{"content":"final"}}]}\ndata: [DONE]\n`;
    expect(new TextEncoder().encode(coalesced).byteLength).toBeGreaterThan(2 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(coalescedSseResponse(coalesced)));

    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).resolves.toEqual([
      { kind: "text", text: "final" },
    ]);
  });

  it("rejects one unterminated SSE line larger than 2 MiB", async () => {
    const oversizedLine = `data: ${"x".repeat(2 * 1024 * 1024)}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unterminatedSseResponse(oversizedLine)));

    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).rejects.toThrow(
      "SSE stream exceeded maximum buffer limit without newlines"
    );
  });

  it.each(["\n", "\r\n"])("rejects one oversized newline-terminated SSE line (%j)", async (ending) => {
    const oversizedLine = `data: ${"x".repeat(2 * 1024 * 1024)}${ending}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(coalescedSseResponse(oversizedLine)));

    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).rejects.toThrow(
      "SSE stream exceeded maximum buffer limit without newlines"
    );
  });

  it("filters out multi-chunk encrypted reasoning notices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"reasoning":"Codex is reasoning, but upstream "}}]}',
          'data: {"choices":[{"delta":{"reasoning":"Responses API exposed this reasoning block only as encrypted private reasoning. "}}]}',
          'data: {"choices":[{"delta":{"reasoning":"OmniRoute cannot recover plaintext."}}]}',
          'data: {"choices":[{"delta":{"content":"Here is your answer"}}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([{ kind: "text", text: "Here is your answer" }]);
  });

  describe("EncryptedReasoningFilter", () => {
    it("buffers prefix and drops complete notice when matched", () => {
      const filter = new EncryptedReasoningFilter();
      const p1 = filter.push("Codex is reasoning, ");
      const p2 = filter.push("but upstream Responses API exposed this reasoning block only as encrypted private reasoning. ");
      const p3 = filter.push("OmniRoute cannot recover plaintext.");
      const flush = filter.flush();
      expect(p1).toEqual([]);
      expect(p2).toEqual([]);
      expect(p3).toEqual([]);
      expect(flush).toEqual([]);
    });

    it("flushes non-notice text immediately when divergence occurs", () => {
      const filter = new EncryptedReasoningFilter();
      const p1 = filter.push("Codex is ");
      const p2 = filter.push("writing code for you.");
      expect(p1).toEqual([]);
      expect(p2).toEqual(["Codex is writing code for you."]);
    });

    it("preserves legitimate text immediately adjacent to an encrypted reasoning notice", () => {
      const filter = new EncryptedReasoningFilter();
      const notice = "Codex is reasoning, but upstream Responses API exposed this reasoning block only as encrypted private reasoning. OmniRoute cannot recover plaintext.";

      const visible = [...filter.push(`Before.${notice}After.`), ...filter.flush()].join("");

      expect(visible).toBe("Before.After.");
    });

    it("removes multiple notices from one buffered sequence without losing legitimate text", () => {
      const filter = new EncryptedReasoningFilter();
      const encryptedNotice = "Codex is reasoning, but upstream Responses API exposed this reasoning block only as encrypted private reasoning. OmniRoute cannot recover plaintext.";
      const requestNotice = "OmniRoute: got req, sending to provider";

      const visible = [
        ...filter.push(`Before.${encryptedNotice}Between.${requestNotice}After.`),
        ...filter.flush(),
      ].join("");

      expect(visible).toBe("Before.Between.After.");
    });

    it("removes 20,000 repeated encrypted and request notices without overflowing the stack", () => {
      const filter = new EncryptedReasoningFilter();
      const encryptedNotice = "Codex is reasoning, but upstream Responses API exposed this reasoning block only as encrypted private reasoning. OmniRoute cannot recover plaintext.";
      const requestNotice = "OmniRoute: got req, sending to provider";
      const repeatedNotices = `${encryptedNotice}${requestNotice}`.repeat(20_000);
      let visible = "";

      expect(() => {
        visible = [
          ...filter.push(`VISIBLE-BEGIN|${repeatedNotices}|VISIBLE-END`),
          ...filter.flush(),
        ].join("");
      }).not.toThrow(RangeError);

      expect(visible).toBe("VISIBLE-BEGIN||VISIBLE-END");
    });
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

  it("sends x-omniroute-compression only when an override is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    await collect(
      new OmniRouteClient({ baseUrl: "http://x/v1", compressionOverride: "engine:rtk" })
    );
    let headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["x-omniroute-compression"]).toBe("engine:rtk");

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(sseResponse(["data: [DONE]"]));
    await collect(
      new OmniRouteClient({ baseUrl: "http://x/v1", compressionOverride: "serverDefault" })
    );
    headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["x-omniroute-compression"]).toBeUndefined();
  });
});

describe("OmniRouteClient retry behavior", () => {
  afterEach(() => vi.unstubAllGlobals());

  const retry = { maxAttempts: 3, baseMs: 1, maxMs: 5 };

  it("retries transient 503 up to maxAttempts then throws upstream detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "Chat admission capacity is temporarily unavailable. Retry shortly." },
        }),
        { status: 503 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      collect(new OmniRouteClient({ baseUrl: "http://x/v1", retry }))
    ).rejects.toThrow(/HTTP 503.*Chat admission capacity/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries 429 too", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1", retry }))).rejects.toThrow(
      /HTTP 429/
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent 4xx errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "no such model" } }), { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1", retry }))).rejects.toThrow(
      /HTTP 404.*no such model/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets the provider disable nested chat retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      collect(new OmniRouteClient({ baseUrl: "http://x/v1", retry, chatMaxAttempts: 1 }))
    ).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries network-level failures (fetch throws) and recovers", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"])
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1", retry }));
    expect(events).toEqual([{ kind: "text", text: "hi" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces network errors after the final attempt", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      collect(new OmniRouteClient({ baseUrl: "http://x/v1", retry }))
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers when a later attempt succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"])
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1", retry }));
    expect(events).toEqual([{ kind: "text", text: "hi" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After over the backoff base", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 503, headers: { "retry-after": "0" } })
      )
      .mockResolvedValueOnce(sseResponse(["data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    // A huge base delay proves Retry-After (0s here) is what makes this fast.
    const events = await collect(
      new OmniRouteClient({
        baseUrl: "http://x/v1",
        retry: { maxAttempts: 2, baseMs: 60_000, maxMs: 60_000 },
      })
    );
    expect(events).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a silent stream via the idle watchdog", async () => {
    const never = new ReadableStream<Uint8Array>({
      start() {
        void 0; // never enqueues nor closes — server hangs
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(never, { status: 200 })));

    const client = new OmniRouteClient({
      baseUrl: "http://x/v1",
      streamFirstByteTimeoutMs: 30,
      streamIdleTimeoutMs: 30,
    });
    const ctrl = new AbortController();
    await expect(
      (async () => {
        for await (const _e of client.streamChat(
          { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
          ctrl.signal
        )) {
          void _e;
        }
      })()
    ).rejects.toThrow("did not start responding");
  });

  it("does not abort a reasoning stream that emits reasoning_content within the first-byte cap but no text yet", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = async (ms: number, line: string) => {
          await new Promise((r) => setTimeout(r, ms));
          controller.enqueue(encoder.encode(`${line}\n`));
        };
        // Reasoning chunks arrive inside the 30ms first-byte window and keep
        // flowing; visible text only lands at 140ms. A watchdog that only
        // counts text events aborts at 30ms — a bug for reasoning models.
        await send(20, 'data: {"choices":[{"delta":{"reasoning_content":"pi"}}]}');
        await send(60, 'data: {"choices":[{"delta":{"reasoning_content":"ng"}}]}');
        await send(100, 'data: {"choices":[{"delta":{"reasoning_content":"po"}}]}');
        await send(140, 'data: {"choices":[{"delta":{"content":"hola"}}]}');
        await send(150, "data: [DONE]");
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    );

    const client = new OmniRouteClient({
      baseUrl: "http://x/v1",
      streamFirstByteTimeoutMs: 30,
      streamIdleTimeoutMs: 200,
    });
    const ctrl = new AbortController();
    const events: StreamEvent[] = [];
    for await (const ev of client.streamChat(
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
      ctrl.signal
    )) {
      events.push(ev);
    }
    expect(events).toEqual([
      { kind: "text", text: "hola" },
    ]);
  });

  it("handles Gemini thought deltas in SSE stream without throwing empty stream", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: string) => controller.enqueue(encoder.encode(`${line}\n`));
        send('data: {"choices":[{"delta":{"thought":"Thinking about answer..."}}]}');
        send('data: {"choices":[{"delta":{"content":"Here is the answer"}}]}');
        send("data: [DONE]");
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    const client = new OmniRouteClient({ baseUrl: "http://x/v1" });
    const ctrl = new AbortController();
    const events: StreamEvent[] = [];
    for await (const ev of client.streamChat(
      { model: "agy/gemini-3.7-flash-tiered", messages: [{ role: "user", content: "hi" }], stream: true },
      ctrl.signal
    )) {
      events.push(ev);
    }
    expect(events).toEqual([
      { kind: "text", text: "Here is the answer" },
    ]);
  });

  it("stops before the first request when already aborted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new AbortController();
    ctrl.abort();
    const client = new OmniRouteClient({ baseUrl: "http://x/v1", retry });
    await expect(
      (async () => {
        for await (const chunk of client.streamChat(
          { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
          ctrl.signal
        )) {
          void chunk;
        }
      })()
    ).rejects.toThrow(/aborted/i);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe("OmniRouteClient.listModels retry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries transient 503 during model discovery", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "openai/gpt-4o" }] }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const models = await new OmniRouteClient({
      baseUrl: "http://x/v1",
      retry: { maxAttempts: 2, baseMs: 1 },
    }).listModels();
    expect(models).toEqual([{ id: "openai/gpt-4o" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("OmniRouteClient error diagnosis", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("describeFetchError unwraps the undici cause chain", () => {
    const cause = new TypeError("fetch failed");
    cause.cause = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    expect(describeFetchError(cause)).toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:8080");
  });

  it("describeFetchError tolerates cyclic causes", () => {
    const a = new Error("fetch failed");
    const b = new Error("level1");
    const c = new Error("level2");
    a.cause = b;
    b.cause = c;
    c.cause = b; // cycle back
    expect(describeFetchError(a)).toBe("fetch failed: level1: level2");
  });

  it("wraps the final network error with cause + phase + endpoint + latency", async () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    const net = new TypeError("fetch failed");
    net.cause = cause;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(net));
    const client = new OmniRouteClient({
      baseUrl: "http://x/v1",
      retry: { maxAttempts: 1, baseMs: 1 },
    });
    const err = await collect(client).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OmniRouteError);
    expect((err as OmniRouteError).message).toMatch(/fetch failed/);
    expect((err as OmniRouteError).message).toMatch(/ECONNREFUSED/);
    expect((err as OmniRouteError).phase).toBe("connect");
    expect((err as OmniRouteError).endpoint).toBe("/v1/chat/completions");
    expect(typeof (err as OmniRouteError).latencyMs).toBe("number");
  });

  it("surfaces SSE inline errors carrying their [status] prefix and stream phase", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse(['data: {"error":{"message":"[429]: Rate limit reached for model openai/gpt-4o"}}'])
      )
    );
    const client = new OmniRouteClient({ baseUrl: "http://x/v1" });
    const err = await collect(client).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OmniRouteError);
    expect((err as OmniRouteError).status).toBe(429);
    expect((err as OmniRouteError).phase).toBe("stream");
    expect((err as OmniRouteError).endpoint).toBe("/chat/completions");
  });

  it("infers rate limit and concurrency throttle status for un-prefixed SSE stream errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse(['data: {"error":{"message":"Resource has been exhausted (e.g. check quota / concurrent requests)"}}'])
      )
    );
    const client = new OmniRouteClient({ baseUrl: "http://x/v1" });
    const err = await collect(client).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OmniRouteError);
    expect((err as OmniRouteError).status).toBe(429);
    expect(isThrottleError(err)).toBe(true);
  });

  it("falls back to the root /models endpoint on 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "local/llama" }] }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);
    const models = await new OmniRouteClient({ baseUrl: "http://x/v1" }).listModels();
    expect(models).toEqual([{ id: "local/llama" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("http://x/models?prefix=alias");
  });

  it("does not fall back on 503 (stays inside the retry loop)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new OmniRouteClient({ baseUrl: "http://x/v1", retry: { maxAttempts: 1, baseMs: 1 } }).listModels()
    ).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("normalizeBaseUrl / serverRootUrl", () => {
  it("appends /v1 to a bare server root (the new default shape)", () => {
    expect(normalizeBaseUrl("http://localhost:20128")).toBe("http://127.0.0.1:20128/v1");
  });

  it("does not double /v1 when the user pasted it (older stored settings)", () => {
    expect(normalizeBaseUrl("http://localhost:20128/v1")).toBe("http://127.0.0.1:20128/v1");
    expect(normalizeBaseUrl("http://localhost:20128/v1/")).toBe("http://127.0.0.1:20128/v1");
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

describe("OmniRouteClient token usage parsing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses Chat Completions trailing usage chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45,"total_tokens":165,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens_details":{"reasoning_tokens":15}}}',
          "data: [DONE]",
        ])
      )
    );

    const client = new OmniRouteClient({ baseUrl: "http://x/v1" });
    const events = await collect(client);

    expect(events).toEqual([
      { kind: "text", text: "Hello" },
      {
        kind: "usage",
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          totalTokens: 165,
          cachedTokens: 80,
          reasoningTokens: 15,
        },
      },
    ]);
  });

  it("parses Responses API completed usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"response.output_text.delta","delta":"Responses answer"}',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":200,"output_tokens":80,"total_tokens":280,"input_tokens_details":{"cached_tokens":150}}}}',
        ])
      )
    );

    const client = new OmniRouteClient({ baseUrl: "http://x/v1" });
    const events = await collectModel(client, ["responses"]);

    expect(events).toEqual([
      { kind: "text", text: "Responses answer" },
      {
        kind: "usage",
        usage: {
          inputTokens: 200,
          outputTokens: 80,
          totalTokens: 280,
          cachedTokens: 150,
          reasoningTokens: undefined,
        },
      },
    ]);
  });

  it("aborts when a runaway stream emits too much unbuffered data without newlines", async () => {
    const hugeUnbrokenData = "x".repeat(3 * 1024 * 1024);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(hugeUnbrokenData));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    const client = new OmniRouteClient({ baseUrl: "http://x/v1" });
    await expect(collect(client)).rejects.toThrow(/exceeded maximum buffer limit/i);
  });
});
