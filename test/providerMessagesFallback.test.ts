import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteError } from "../src/client";
import { OmniRouteChatProvider } from "../src/provider";
import * as routesModule from "../src/routes";
import { configValues } from "./vscode.mock";

function mockContext() {
  const store = new Map<string, unknown>();
  return { globalState: {
    get: <T,>(key: string): T | undefined => store.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { store.set(key, value); },
  } } as unknown as ConstructorParameters<typeof OmniRouteChatProvider>[0]["context"];
}

const mockLog = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  name: "messages-test", logLevel: 0, onDidChangeLogLevel: () => ({ dispose: () => {} }),
  append: () => {}, appendLine: () => {}, replace: () => {}, clear: () => {}, show: () => {}, hide: () => {}, dispose: () => {},
} as unknown as vscode.LogOutputChannel;

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
} as unknown as vscode.CancellationToken;

async function prepare(primaryStream: () => AsyncGenerator<unknown>, fallbackStream: () => AsyncGenerator<unknown>) {
  configValues["omnicopilot"] = { retriesPerServer: 1, fallbackMode: "sameModel" };
  const clientA = {
    baseUrl: "http://a/v1",
    listModels: vi.fn().mockResolvedValue([{ id: "anthropic/claude", supported_endpoints: ["POST /v1/messages"] }]),
    streamModel: vi.fn().mockImplementation(primaryStream),
  };
  const clientB = {
    baseUrl: "http://b/v1",
    listModels: vi.fn().mockResolvedValue([{ id: "anthropic/claude", supported_endpoints: ["responses"] }]),
    streamModel: vi.fn().mockImplementation(fallbackStream),
  };
  vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
    { id: "A", name: "A", baseUrl: "http://a/v1" },
    { id: "B", name: "B", baseUrl: "http://b/v1" },
  ]);
  vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
    ((route: routesModule.Route) => route.id === "A" ? clientA : clientB) as unknown as typeof routesModule.getClientForRoute
  );
  const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
  await provider.refresh();
  await provider.provideLanguageModelChatInformation({ silent: true }, token);
  const model = {
    id: "A · anthropic/claude", omniModelId: "anthropic/claude", routeId: "A",
  } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
  return { provider, model, clientA, clientB };
}

describe("Messages-aware provider fallback", () => {
  afterEach(() => {
    routesModule.resetAllCooldowns();
    delete configValues["omnicopilot"];
    vi.restoreAllMocks();
  });

  it("dispatches a Messages-only primary and falls back cross-route before output", async () => {
    const { provider, model, clientA, clientB } = await prepare(
      async function* () { throw new OmniRouteError("messages unavailable", 503, false, "headers", "/messages"); },
      async function* () { yield { kind: "text", text: "fallback" }; }
    );
    const progress = { report: vi.fn() };
    await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);
    expect(clientA.streamModel.mock.calls[0][2]).toEqual(["messages"]);
    expect(clientB.streamModel.mock.calls[0][2]).toEqual(["responses"]);
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ value: "fallback" }));
  });

  it("does not cross-route fallback after Messages produced visible output", async () => {
    const failure = new OmniRouteError("midstream failure", 503, false, "stream", "/messages");
    const { provider, model, clientA, clientB } = await prepare(
      async function* () { yield { kind: "text", text: "partial" }; throw failure; },
      async function* () { yield { kind: "text", text: "must not run" }; }
    );
    const progress = { report: vi.fn() };
    await expect(provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token))
      .rejects.toBe(failure);
    expect(clientA.streamModel.mock.calls[0][2]).toEqual(["messages"]);
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ value: "partial" }));
    expect(clientB.streamModel).not.toHaveBeenCalled();
  });
});