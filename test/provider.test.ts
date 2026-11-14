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
 * stubbed by the test. `reported` collects everything sent to `progress.report`. */
function makeProvider(overrides: { config?: Record<string, unknown> } = {}) {
  setMockConfig({ baseUrl: "http://gateway.test/v1", ...overrides.config });
  const reported: Reported[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const context = fakeContext();
  const provider = new OmniRouteChatProvider({
    context: context as unknown as vscode.ExtensionContext,
    log: log as unknown as vscode.LogOutputChannel,
  });
  const progress: vscode.Progress<Reported> = { report: (part) => void reported.push(part) };
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  } as unknown as vscode.CancellationToken;
  return { provider, context, reported, log, progress, token };
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
