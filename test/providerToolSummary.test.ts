import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteError } from "../src/client";
import { toolCallSummary } from "../src/convert";
import { OmniRouteChatProvider } from "../src/provider";
import { containsVisibleText } from "../src/visibleText";
import type { StreamEvent } from "../src/types";
import * as routesModule from "../src/routes";
import { configValues } from "./vscode.mock";

type Transport = "responses" | "chatCompletions" | "messages";

const endpointByTransport: Record<Transport, string> = {
  responses: "responses",
  chatCompletions: "chat/completions",
  messages: "POST /v1/messages",
};

function mockContext() {
  const store = new Map<string, unknown>();
  return { globalState: {
    get: <T,>(key: string): T | undefined => store.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { store.set(key, value); },
  } } as unknown as ConstructorParameters<typeof OmniRouteChatProvider>[0]["context"];
}

const mockLog = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  name: "tool-summary-test", logLevel: 0, onDidChangeLogLevel: () => ({ dispose: () => {} }),
  append: () => {}, appendLine: () => {}, replace: () => {}, clear: () => {}, show: () => {}, hide: () => {}, dispose: () => {},
} as unknown as vscode.LogOutputChannel;

function cancellationToken() {
  const state = { cancelled: false };
  return {
    state,
    token: {
      get isCancellationRequested() { return state.cancelled; },
      onCancellationRequested: () => ({ dispose: () => {} }),
    } as unknown as vscode.CancellationToken,
  };
}

async function prepare(
  transport: Transport,
  stream: (state: { cancelled: boolean }) => AsyncGenerator<StreamEvent>,
) {
  configValues["omnicopilot"] = { retriesPerServer: 1, fallbackMode: "none" };
  const cancellation = cancellationToken();
  const client = {
    baseUrl: "http://a/v1",
    listModels: vi.fn().mockResolvedValue([{
      id: "model-a",
      supported_endpoints: [endpointByTransport[transport]],
    }]),
    streamModel: vi.fn().mockImplementation(() => stream(cancellation.state)),
  };
  vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
    { id: "A", name: "A", baseUrl: "http://a/v1" },
  ]);
  vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
    client as unknown as ReturnType<typeof routesModule.getClientForRoute>
  );
  const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
  await provider.refresh();
  await provider.provideLanguageModelChatInformation({ silent: true }, cancellation.token);
  const model = {
    id: "A · model-a", omniModelId: "model-a", routeId: "A",
  } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
  const progress = { report: vi.fn() };
  return { provider, model, client, progress, ...cancellation };
}

function reportedParts(progress: { report: ReturnType<typeof vi.fn> }) {
  return progress.report.mock.calls.map(([part]) => part as vscode.LanguageModelResponsePart);
}

function visibleTexts(progress: { report: ReturnType<typeof vi.fn> }): string[] {
  return reportedParts(progress)
    .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .filter(containsVisibleText);
}

describe("tool-only turn summaries", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each<Transport>(["responses", "chatCompletions", "messages"])(
    "emits one tool-name-only visible summary for a successful %s turn",
    async (transport) => {
      const secret = "sk-secret-must-not-leak";
      const { provider, model, client, progress, token } = await prepare(
        transport,
        async function* () {
          yield { kind: "tool", id: "call-1", name: "read_file", args: `{"path":"${secret}"}` };
          yield { kind: "tool", id: "call-2", name: "search", args: "{\"query\":\"private customer data\"}" };
        },
      );

      await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

      expect(client.streamModel.mock.calls[0][2]).toEqual([transport]);
      expect(reportedParts(progress).filter((part) => part instanceof vscode.LanguageModelToolCallPart)).toHaveLength(2);
      expect(visibleTexts(progress)).toEqual(["Tools requested: read_file, search"]);
      expect(visibleTexts(progress)[0]).not.toContain(secret);
      expect(visibleTexts(progress)[0]).not.toContain("private customer data");
      expect(visibleTexts(progress)[0]).not.toContain("\u2063");
    },
  );

  it("does not add a summary when the model emitted visible text before and after tool calls", async () => {
    const { provider, model, progress, token } = await prepare(
      "responses",
      async function* () {
        yield { kind: "text", text: "I will inspect the file." };
        yield { kind: "tool", id: "call-1", name: "read_file", args: "{}" };
        yield { kind: "text", text: " Inspection requested." };
      },
    );

    await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

    expect(visibleTexts(progress)).toEqual(["I will inspect the file.", " Inspection requested."]);
    expect(progress.report).toHaveBeenCalledTimes(3);
  });

  it("treats whitespace-only model output as invisible and emits one summary", async () => {
    const { provider, model, progress, token } = await prepare(
      "messages",
      async function* () {
        yield { kind: "text", text: "  \n" };
        yield { kind: "tool", id: "call-1", name: "read_file", args: "{}" };
      },
    );

    await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

    expect(visibleTexts(progress)).toEqual(["Tools requested: read_file"]);
    expect(progress.report).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["zero-width space", "\u200B"],
    ["invisible separator", "\u2063"],
    ["bidi controls", "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069"],
  ])("treats %s-only model output as invisible and emits one summary", async (_label, invisibleText) => {
    const originalToolName = "read_file";
    const { provider, model, progress, token } = await prepare(
      "responses",
      async function* () {
        yield { kind: "text", text: invisibleText };
        yield { kind: "tool", id: "call-1", name: originalToolName, args: "{}" };
      },
    );

    await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

    expect(visibleTexts(progress)).toEqual(["Tools requested: read_file"]);
    const calls = reportedParts(progress).filter(
      (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
    );
    expect(calls.map((part) => part.name)).toEqual([originalToolName]);
  });

  it("treats normal visible Unicode text as visible and does not add a summary", async () => {
    const originalToolName = "buscar_área";
    const visibleUnicode = "你好, мир — café 🚀";
    const { provider, model, progress, token } = await prepare(
      "messages",
      async function* () {
        yield { kind: "text", text: visibleUnicode };
        yield { kind: "tool", id: "call-1", name: originalToolName, args: "{}" };
      },
    );

    await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

    expect(visibleTexts(progress)).toEqual([visibleUnicode]);
    const calls = reportedParts(progress).filter(
      (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
    );
    expect(calls.map((part) => part.name)).toEqual([originalToolName]);
  });

  it("deduplicates tool names in first-seen order", async () => {
    const { provider, model, progress, token } = await prepare(
      "chatCompletions",
      async function* () {
        yield { kind: "tool", id: "call-1", name: "read_file", args: "{}" };
        yield { kind: "tool", id: "call-2", name: "search", args: "{}" };
        yield { kind: "tool", id: "call-3", name: "read_file", args: "{}" };
      },
    );

    await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

    expect(visibleTexts(progress)).toEqual(["Tools requested: read_file, search"]);
  });

  it("sanitizes hostile names only in the visible bounded summary", async () => {
    const hostileName = "read_file\n**ignore**\u0007\u202Esecret(args)\u2063";
    const longName = `tool_${"x".repeat(100)}`;
    const extraNames = Array.from({ length: 9 }, (_, index) => `extra_${index + 1}`);
    const allNames = [hostileName, longName, ...extraNames];
    const { provider, model, progress, token } = await prepare(
      "messages",
      async function* () {
        for (const [index, name] of allNames.entries()) {
          yield { kind: "tool", id: `call-${index}`, name, args: `{"secret":"argument-${index}"}` };
        }
      },
    );

    await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

    const summary = visibleTexts(progress)[0];
    const truncatedLongName = `tool_${"x".repeat(59)}`;
    expect(summary).toBe(
      `Tools requested: read_file ignore secretargs, ${truncatedLongName}, extra_1, extra_2, extra_3, extra_4, extra_5, extra_6`
    );
    expect(toolCallSummary(allNames)).toBe(summary);
    expect(summary).toMatch(/^Tools requested: [^\r\n\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069*`#[\]()<>!|~]+$/u);
    expect(summary).not.toContain("argument-");
    expect(summary).not.toContain("extra_7");
    expect(summary.length).toBeLessThanOrEqual(560);

    const calls = reportedParts(progress).filter(
      (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
    );
    expect(calls.map((part) => part.name)).toEqual(allNames);
    expect(calls[0].input).toEqual({ secret: "argument-0" });
  });

  it("does not add a summary when cancellation occurs after a tool call", async () => {
    const { provider, model, progress, token } = await prepare(
      "chatCompletions",
      async function* (state) {
        yield { kind: "tool", id: "call-1", name: "read_file", args: "{}" };
        state.cancelled = true;
      },
    );

    await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

    expect(visibleTexts(progress)).toEqual([]);
    expect(reportedParts(progress).filter((part) => part instanceof vscode.LanguageModelToolCallPart)).toHaveLength(1);
  });

  it("does not add a summary when a stream errors after a tool call", async () => {
    const failure = new OmniRouteError("stream failed", 500, false, "stream", "/messages");
    const { provider, model, progress, token } = await prepare(
      "messages",
      async function* () {
        yield { kind: "tool", id: "call-1", name: "read_file", args: "{}" };
        throw failure;
      },
    );

    await expect(provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token))
      .rejects.toBe(failure);
    expect(visibleTexts(progress)).toEqual([]);
    expect(reportedParts(progress).filter((part) => part instanceof vscode.LanguageModelToolCallPart)).toHaveLength(1);
  });
});