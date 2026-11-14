import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { setMockConfig } from "./vscode.mock";
import { OmniRouteChatProvider } from "../src/provider";

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


describe("provider chat path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

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
