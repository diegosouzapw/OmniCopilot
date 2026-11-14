import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { setMockConfig } from "./vscode.mock";
import { OmniRouteChatProvider } from "../src/provider";
import { aliasToolName } from "../src/toolNames";

function sseResponse(chunks: unknown[]): Response {
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]"];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function memento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  };
}

function fakeContext() {
  const secrets = new Map<string, string>();
  return {
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    globalState: memento(),
    workspaceState: memento(),
    subscriptions: [] as { dispose(): void }[],
  };
}

type Reported = vscode.LanguageModelResponsePart;

/** A provider wired to a fake extension context, with the global `fetch`
 * stubbed by the test. `reported` collects everything sent to `progress.report`;
 * `activity` collects every connection signal; `cancel()` fires the token. */
function makeProvider(overrides: { config?: Record<string, unknown> } = {}) {
  setMockConfig({ baseUrl: "http://gateway.test/v1", ...overrides.config });
  const reported: Reported[] = [];
  const activity: boolean[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const context = fakeContext();
  const provider = new OmniRouteChatProvider({
    context: context as unknown as vscode.ExtensionContext,
    log: log as unknown as vscode.LogOutputChannel,
    onActivity: (ok) => void activity.push(ok),
  });
  const progress: vscode.Progress<Reported> = { report: (part) => void reported.push(part) };
  const listeners = new Set<() => void>();
  const state = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
  };
  const token = state as unknown as vscode.CancellationToken;
  const cancel = () => {
    state.isCancellationRequested = true;
    for (const listener of [...listeners]) listener();
  };
  return { provider, context, reported, activity, log, progress, token, cancel };
}

function modelInfo(imageInput: boolean) {
  return {
    id: "m",
    omniModelId: "m",
    name: "m",
    family: "f",
    version: "1",
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    capabilities: { toolCalling: true, imageInput },
  } as never;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): {
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: unknown }>;
} {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string);
}

const long = "mcp_" + "a".repeat(40) + "_" + "b".repeat(30); // 75 characters

describe("provider chat path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends aliased tool names and reports the original name back to the editor", async () => {
    const wire = aliasToolName(long);
    fetchMock.mockResolvedValue(
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_9", function: { name: wire, arguments: "{}" } }],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ])
    );
    const { provider, reported, progress, token } = makeProvider();

    await provider.provideLanguageModelChatResponse(
      modelInfo(false),
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { tools: [{ name: long, description: "d", inputSchema: {} }], toolMode: 1 } as never,
      progress,
      token
    );

    const body = requestBody(fetchMock);
    expect(body.tools?.[0].function.name).toHaveLength(64);
    expect(body.tools?.[0].function.name).toBe(wire);
    const call = reported[0];
    expect(call).toBeInstanceOf(vscode.LanguageModelToolCallPart);
    expect((call as vscode.LanguageModelToolCallPart).name).toBe(long);
  });

  it("aliases names of tool calls already in the history", async () => {
    fetchMock.mockResolvedValue(sseResponse([{ choices: [{ delta: { content: "ok" } }] }]));
    const { provider, progress, token } = makeProvider();
    await provider.provideLanguageModelChatResponse(
      modelInfo(false),
      [
        {
          role: vscode.LanguageModelChatMessageRole.Assistant,
          content: [new vscode.LanguageModelToolCallPart("call_1", long, {})],
        } as never,
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [
            new vscode.LanguageModelToolResultPart("call_1", [new vscode.LanguageModelTextPart("done")]),
          ],
        } as never,
      ],
      { tools: [], toolMode: 1 } as never,
      progress,
      token
    );
    const messages = requestBody(fetchMock).messages as Array<{
      tool_calls?: Array<{ function: { name: string } }>;
    }>;
    expect(messages[0].tool_calls?.[0].function.name).toBe(aliasToolName(long));
  });

  it.each([
    [false, false],
    [true, true],
  ])("passes imageInput=%s from the model to the conversion", async (imageInput, expectImage) => {
    fetchMock.mockResolvedValue(sseResponse([{ choices: [{ delta: { content: "ok" } }] }]));
    const { provider, progress, token } = makeProvider();
    const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
    await provider.provideLanguageModelChatResponse(
      modelInfo(imageInput),
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelToolResultPart("call_1", [img])],
        } as never,
      ],
      { tools: [], toolMode: 1 } as never,
      progress,
      token
    );
    const sent = JSON.stringify(requestBody(fetchMock).messages);
    expect(sent.includes("image_url")).toBe(expectImage);
    expect(sent.includes("[1,2,3]")).toBe(false);
  });

  it("still reports a usage part at the end of the response", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        { choices: [{ delta: { content: "hi" } }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      ])
    );
    const { provider, reported, progress, token } = makeProvider();
    await provider.provideLanguageModelChatResponse(
      modelInfo(false),
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { tools: [], toolMode: 1 } as never,
      progress,
      token
    );
    expect(reported[0]).toBeInstanceOf(vscode.LanguageModelTextPart);
    expect(reported[reported.length - 1]).toBeInstanceOf(vscode.LanguageModelDataPart);
  });
});

describe("provider catalog", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function catalog(data: unknown[]): Response {
    return new Response(JSON.stringify({ object: "list", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("lists models with the name and limits OmniRoute really sends", async () => {
    fetchMock.mockResolvedValue(
      catalog([
        { id: "x/y", name: "Y Pro", context_length: 200_000, max_output_tokens: 8_192, max_input_tokens: 150_000 },
      ])
    );
    const { provider, token } = makeProvider();
    const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    expect(info.name).toBe("Y Pro");
    expect(info.maxOutputTokens).toBe(8_192);
    expect(info.maxInputTokens).toBe(150_000);
  });

  it("keeps half of a small context window for the prompt", async () => {
    fetchMock.mockResolvedValue(catalog([{ id: "tiny", context_length: 8_192 }]));
    const { provider, token } = makeProvider();
    const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    expect(info.maxOutputTokens).toBe(4_096);
    expect(info.maxInputTokens).toBe(4_096);
  });

  it("sends max as its own tier and honours tiers the model advertises", async () => {
    fetchMock.mockResolvedValueOnce(
      catalog([{ id: "r", capabilities: { reasoning: true, effort_tiers: ["low", "high", "max"] } }])
    );
    const { provider, progress, token } = makeProvider({ config: { defaultReasoningEffort: "max" } });
    await provider.provideLanguageModelChatInformation({ silent: true }, token);
    fetchMock.mockResolvedValueOnce(sseResponse([{ choices: [{ delta: { content: "ok" } }] }]));
    await provider.provideLanguageModelChatResponse(
      { ...(modelInfo(false) as object), id: "r", omniModelId: "r" } as never,
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { tools: [], toolMode: 1 } as never,
      progress,
      token
    );
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(init.body as string).reasoning_effort).toBe("max");
  });
});

describe("provider effort picker", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  type Schema = {
    properties: {
      reasoningEffort: {
        title: string;
        enum: string[];
        enumItemLabels: string[];
        group: string;
        default?: string;
      };
    };
  };

  async function list(config: Record<string, unknown> = {}) {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "plain" },
            { id: "thinker", capabilities: { reasoning: true } },
            { id: "tiered", capabilities: { thinking: true, effort_tiers: ["low", "high", "max"] } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const { provider, progress, token } = makeProvider({ config });
    const infos = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const byId = new Map(infos.map((i) => [i.id, i as unknown as { configurationSchema?: Schema }]));
    return { provider, progress, token, byId };
  }

  it("declares the effort picker only on reasoning models", async () => {
    const { byId } = await list();
    expect(byId.get("plain")?.configurationSchema).toBeUndefined();
    const thinker = byId.get("thinker")?.configurationSchema?.properties.reasoningEffort;
    expect(thinker?.title).toBe("Thinking effort");
    expect(thinker?.group).toBe("navigation");
    expect(thinker?.enum).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(thinker?.enumItemLabels).toEqual(["Off", "Low", "Medium", "High", "Extra high", "Max"]);
    expect("default" in (thinker as object)).toBe(false);
  });

  it("offers exactly the tiers the model advertises, labelling unknown ones by id", async () => {
    const { byId } = await list();
    const tiered = byId.get("tiered")?.configurationSchema?.properties.reasoningEffort;
    expect(tiered?.enum).toEqual(["low", "high", "max"]);
    expect(tiered?.enumItemLabels).toEqual(["Low", "High", "Max"]);
  });

  it("preselects the configured default only on models that offer it", async () => {
    const { byId } = await list({ defaultReasoningEffort: "medium" });
    expect(byId.get("thinker")?.configurationSchema?.properties.reasoningEffort.default).toBe("medium");
    expect("default" in (byId.get("tiered")?.configurationSchema?.properties.reasoningEffort as object)).toBe(false);
  });

  async function chat(
    provider: OmniRouteChatProvider,
    progress: vscode.Progress<Reported>,
    token: vscode.CancellationToken,
    options: Record<string, unknown>
  ) {
    fetchMock.mockResolvedValueOnce(sseResponse([{ choices: [{ delta: { content: "ok" } }] }]));
    await provider.provideLanguageModelChatResponse(
      { ...(modelInfo(false) as object), id: "thinker", omniModelId: "thinker" } as never,
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { tools: [], toolMode: 1, ...options } as never,
      progress,
      token
    );
    const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as RequestInit;
    return JSON.parse(init.body as string) as { reasoning_effort?: string };
  }

  it("forwards the effort chosen in the picker as reasoning_effort", async () => {
    const { provider, progress, token } = await list({ defaultReasoningEffort: "low" });
    const body = await chat(provider, progress, token, {
      modelConfiguration: { reasoningEffort: "high" },
    });
    expect(body.reasoning_effort).toBe("high");
  });

  it("forwards max unchanged", async () => {
    const { provider, progress, token } = await list();
    const body = await chat(provider, progress, token, {
      modelConfiguration: { reasoningEffort: "max" },
    });
    expect(body.reasoning_effort).toBe("max");
  });

  it("sends no reasoning_effort when nothing was picked and no default is set", async () => {
    const { provider, progress, token } = await list();
    const body = await chat(provider, progress, token, {});
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("provider request retries", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const userMessage = {
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new vscode.LanguageModelTextPart("go")],
  } as never;

  function ask(ctx: ReturnType<typeof makeProvider>): Promise<unknown> {
    // Attach the handler right away so a rejection is never left unhandled
    // while the fake clock is being advanced.
    return ctx.provider
      .provideLanguageModelChatResponse(
        modelInfo(false),
        [userMessage],
        { tools: [], toolMode: 1 } as never,
        ctx.progress,
        ctx.token
      )
      .then(
        () => ({ ok: true }),
        (error: Error) => ({ ok: false, error })
      );
  }

  const cooling = (retryAfter: string) =>
    new Response(
      JSON.stringify({
        error: { message: "All credentials for model m are cooling down", reset_seconds: 1 },
      }),
      { status: 429, headers: { "Retry-After": retryAfter } }
    );
  const status = (code: number) =>
    new Response(JSON.stringify({ error: { message: `upstream ${code}` } }), { status: code });
  const text = (value: string) => ({ choices: [{ delta: { content: value } }] });
  const dataParts = (reported: Reported[]) =>
    reported.filter((part) => part instanceof vscode.LanguageModelDataPart);

  it("retries a cooling-down model on its own and reports the answer once", async () => {
    fetchMock
      .mockResolvedValueOnce(cooling("1"))
      .mockResolvedValueOnce(
        sseResponse([
          text("hello"),
          { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
        ])
      );
    const ctx = makeProvider();
    const result = ask(ctx);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const texts = ctx.reported.filter((p) => p instanceof vscode.LanguageModelTextPart);
    expect(texts).toHaveLength(1);
    expect(dataParts(ctx.reported)).toHaveLength(1);
    expect(ctx.reported[ctx.reported.length - 1]).toBeInstanceOf(vscode.LanguageModelDataPart);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(String(ctx.log.warn.mock.calls[0][0])).toMatch(/retry/i);
    expect(ctx.activity).toEqual([true]);
  });

  it("waits for the reset hint of an error that arrives inside the stream", async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([{ error: { message: "[x/y] [503]: busy (reset after 2s)" } }])
      )
      .mockResolvedValueOnce(sseResponse([text("back")]));
    const ctx = makeProvider();
    const result = ask(ctx);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a usage chunk from a failed attempt count as streamed output", async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          { choices: [], usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 } },
          { error: { message: "[503]: busy (reset after 1s)" } },
        ])
      )
      .mockResolvedValueOnce(sseResponse([text("ok")]));
    const ctx = makeProvider();
    const result = ask(ctx);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dataParts(ctx.reported)).toHaveLength(1);
    // the usage part comes from the attempt that succeeded, not the failed one
    const payload = JSON.parse(
      new TextDecoder().decode((dataParts(ctx.reported)[0] as vscode.LanguageModelDataPart).data)
    );
    expect(payload.prompt_tokens).not.toBe(9);
  });

  it("does not retry once text has been streamed", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([text("partial"), { error: { message: "[503]: busy (reset after 1s)" } }])
    );
    const ctx = makeProvider();
    const result = (await ask(ctx)) as { ok: boolean; error: Error };

    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("[503]: busy (reset after 1s)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.reported).toHaveLength(1);
    expect(ctx.activity).toEqual([true]);
  });

  it("does not retry once a tool call has been reported", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "run", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        { error: { message: "[503]: busy (reset after 1s)" } },
      ])
    );
    const ctx = makeProvider();
    const result = (await ask(ctx)) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.reported[0]).toBeInstanceOf(vscode.LanguageModelToolCallPart);
  });

  it("gives up with the server's message when the wait is longer than the cap", async () => {
    fetchMock.mockResolvedValue(cooling("120"));
    const ctx = makeProvider();
    const result = (await ask(ctx)) as { ok: boolean; error: Error };

    expect(result.ok).toBe(false);
    expect(result.error.message).toBe(
      "OmniRoute request failed (HTTP 429): All credentials for model m are cooling down"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks the message of an error it retried and gave up on", async () => {
    fetchMock.mockImplementation(async () => status(503));
    const ctx = makeProvider();
    const result = ask(ctx);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);

    const outcome = (await result) as { ok: boolean; error: Error };
    expect(outcome.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outcome.error.message).toBe("OmniRoute request failed (HTTP 503): upstream 503 (retried 2×)");
  });

  it("never retries a client error", async () => {
    fetchMock.mockResolvedValue(status(400));
    const ctx = makeProvider();
    const outcome = (await ask(ctx)) as { ok: boolean; error: Error };

    expect(outcome.ok).toBe(false);
    expect(outcome.error.message).not.toContain("retried");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the request is cancelled", async () => {
    fetchMock.mockResolvedValue(cooling("5"));
    const ctx = makeProvider();
    const result = ask(ctx);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    ctx.cancel();

    expect(await result).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.reported).toHaveLength(0);
    expect(ctx.activity).toEqual([]);
  });

  it("keeps the connection marked online after an HTTP error", async () => {
    fetchMock.mockResolvedValue(status(401));
    const ctx = makeProvider();
    await ask(ctx);
    expect(ctx.activity).toEqual([true]);
  });

  it("marks the connection offline after a network error, once retries are spent", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }));
    const ctx = makeProvider();
    const result = ask(ctx);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);

    const outcome = (await result) as { ok: boolean; error: Error };
    expect(outcome.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outcome.error.message).toMatch(/ECONNREFUSED.*\(retried 2×\)$/);
    expect(ctx.activity).toEqual([false]);
  });

  it("does not mark the server offline when model discovery is refused with a 401", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const ctx = makeProvider();
    expect(await ctx.provider.provideLanguageModelChatInformation({ silent: true }, ctx.token)).toEqual([]);
    expect(ctx.activity).toEqual([true]);
  });

  it("marks the server offline when model discovery cannot reach it", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const ctx = makeProvider();
    expect(await ctx.provider.provideLanguageModelChatInformation({ silent: true }, ctx.token)).toEqual([]);
    expect(ctx.activity).toEqual([false]);
  });
});

describe("provider test harness", () => {
  it("offers secrets, globalState and workspaceState backed by maps", async () => {
    const { context } = makeProvider();
    await context.secrets.store("k", "v");
    expect(await context.secrets.get("k")).toBe("v");
    await context.secrets.delete("k");
    expect(await context.secrets.get("k")).toBeUndefined();
    await context.globalState.update("g", 1);
    await context.workspaceState.update("w", 2);
    expect(context.globalState.get("g")).toBe(1);
    expect(context.workspaceState.get("w")).toBe(2);
  });
});
