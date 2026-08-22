import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteChatProvider } from "../src/provider";
import { OmniRouteError } from "../src/client";
import * as routesModule from "../src/routes";
import { configValues } from "./vscode.mock";

/**
 * End-to-end-ish proof that the "full" fallback chain actually runs inside
 * provideLanguageModelChatResponse: two servers, same model on both, primary
 * unreachable → the request is served by the second server and the caller
 * learns 1 fallback was used via onRequestEnd(ok=true, error, fallbacksUsed=1).
 */

function mockContext() {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: <T,>(key: string): T | undefined => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  } as unknown as ConstructorParameters<typeof OmniRouteChatProvider>[0]["context"];
}

const mockLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  name: "mockLog",
  loglevel: 0,
  onDidChangeLogLevel: () => ({ dispose: () => {} }),
  append: () => {},
  appendLine: () => {},
  clear: () => {},
  show: () => {},
  hide: () => {},
  dispose: () => {},
  debug: () => {},
  trace: () => {},
} as unknown as vscode.LogOutputChannel;

const dummyToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
} as unknown as vscode.CancellationToken;

async function* streamText(text: string): AsyncGenerator<{ kind: string; text: string }> {
  yield { kind: "text", text };
}

describe("full fallback at the request level", () => {
  afterEach(() => {
    routesModule.resetAllCooldowns();
    delete configValues["omnicopilot"];
    vi.restoreAllMocks();
  });

  it("performs the initial request when retriesPerServer is zero", async () => {
    configValues["omnicopilot"] = { retriesPerServer: 0, fallbackMode: "sameModel" };
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onRequestEnd });
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(() => streamText("initial attempt answered")),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    expect(client.streamModel).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "initial attempt answered" })
    );
    expect(onRequestEnd).toHaveBeenCalledWith(true, undefined, 0);
  });

  it("treats retriesPerServer as retries after the initial attempt", async () => {
    configValues["omnicopilot"] = { retriesPerServer: 2, fallbackMode: "sameModel" };
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onRequestEnd });
    let attempts = 0;
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        attempts += 1;
        if (attempts <= 2) {
          throw new OmniRouteError(
            "temporarily unavailable",
            503,
            false,
            "headers",
            "/chat/completions",
            undefined,
            0
          );
        }
        yield { kind: "text", text: "third attempt answered" };
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    expect(client.streamModel).toHaveBeenCalledTimes(3);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "third attempt answered" })
    );
    expect(onRequestEnd).toHaveBeenCalledWith(true, undefined, 0);
  });

  it("defaults retriesPerServer to one retry after the initial attempt", async () => {
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    let attempts = 0;
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        attempts += 1;
        if (attempts === 1) {
          throw new OmniRouteError("temporarily unavailable", 503, false, "headers", undefined, undefined, 0);
        }
        yield { kind: "text", text: "default retry answered" };
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    await provider.provideLanguageModelChatResponse(
      { id: "Server A · openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as never,
      [],
      {} as never,
      { report: vi.fn() } as never,
      dummyToken
    );

    expect(client.streamModel).toHaveBeenCalledTimes(2);
  });

  it("serves the request from a second server when the primary fails", async () => {
    configValues["omnicopilot"] = { retriesPerServer: 1, fallbackMode: "full" };

    const context = mockContext();
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context, log: mockLog, onRequestEnd });

    // Server A: healthy at model-listing time but its chat endpoint is down.
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("fetch failed", undefined);
      }),
    };
    // Server B: serves the same model (full fallback tier 1) and extra models.
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi
        .fn()
        .mockResolvedValue([{ id: "openai/gpt-4o" }, { id: "kimi/k2" }]),
      streamModel: vi.fn().mockImplementation(() => streamText("fallback reply")),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => (route.id === "A" ? clientA : clientB)) as unknown as typeof routesModule.getClientForRoute
    );

    // Seed the catalog (both servers' models) the way the extension does:
    // refresh() only clears shared caches — model discovery runs on the
    // provideLanguageModelChatInformation call.
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    // The primary was tried, then the same model on server B answered.
    expect(clientA.streamModel).toHaveBeenCalled();
    expect(clientB.streamModel).toHaveBeenCalled();
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "fallback reply" })
    );
    // ok=true, no error, exactly 1 fallback consumed.
    expect(onRequestEnd).toHaveBeenCalledWith(true, undefined, 1);
  });

  it("tries offline fallback candidate if primary fails instead of dropping it", async () => {
    configValues["omnicopilot"] = { retriesPerServer: 1, fallbackMode: "sameModel" };

    const context = mockContext();
    const onRequestEnd = vi.fn();
    // Only server A is currently in the online set (e.g. server B failed a transient ping)
    const getOnlineRouteIds = vi.fn().mockReturnValue(new Set(["A"]));
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
      onRequestEnd,
      getOnlineRouteIds,
    });

    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("fetch failed", undefined);
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(() => streamText("offline server answered")),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => (route.id === "A" ? clientA : clientB)) as unknown as typeof routesModule.getClientForRoute
    );

    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    expect(clientA.streamModel).toHaveBeenCalled();
    expect(clientB.streamModel).toHaveBeenCalled();
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "offline server answered" })
    );
    expect(onRequestEnd).toHaveBeenCalledWith(true, undefined, 1);
  });

  it.each([429, 503])("honors retriesPerServer for HTTP %i admission failures and immediately tries another route", async (status) => {
    configValues["omnicopilot"] = { retriesPerServer: 1, fallbackMode: "full" };

    const context = mockContext();
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
      onRequestEnd,
    });

    // Server A: admission full for both models.
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([
        { id: "openai/gpt-4o" },
        { id: "openai/gpt-4o-mini" },
      ]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("Chat admission capacity is temporarily unavailable", status);
      }),
    };
    // Server B: healthy backup
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(() => streamText("server B answered")),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => (route.id === "A" ? clientA : clientB)) as unknown as typeof routesModule.getClientForRoute
    );

    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    // The initial attempt plus the configured retry are honored; same-route
    // fallback is skipped after admission remains saturated.
    expect(clientA.streamModel).toHaveBeenCalledTimes(2);
    // The other route is tried immediately and succeeds.
    expect(clientB.streamModel).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "server B answered" })
    );
    expect(onRequestEnd).toHaveBeenCalledWith(true, undefined, expect.any(Number));
  });

  it("does not reuse a throttled route through a later lower-quality fallback", async () => {
    configValues["omnicopilot"] = { retriesPerServer: 0, fallbackMode: "full" };
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([
        { id: "openai/gpt-4o" },
        { id: "openai/gpt-4o-mini" },
      ]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("admission saturated", 503);
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("backup unavailable", 500);
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => route.id === "A" ? clientA : clientB) as unknown as typeof routesModule.getClientForRoute
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    await expect(provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      { report: vi.fn() } as unknown as vscode.Progress<unknown>,
      dummyToken
    )).rejects.toBeInstanceOf(OmniRouteError);

    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientA.streamModel.mock.calls[0][0]).toMatchObject({ model: "openai/gpt-4o" });
    expect(clientB.streamModel).toHaveBeenCalledTimes(1);
  });

  it("rethrows an exhausted admission failure without showing extension error UI", async () => {
    configValues["omnicopilot"] = { retriesPerServer: 1, fallbackMode: "sameModel" };
    const showErrorMessage = vi.spyOn(vscode.window, "showErrorMessage");
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    const failure = new OmniRouteError("Chat admission capacity is temporarily unavailable", 503);
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw failure;
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    await expect(provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      { report: vi.fn() } as unknown as vscode.Progress<unknown>,
      dummyToken
    )).rejects.toBe(failure);

    expect.soft(client.streamModel).toHaveBeenCalledTimes(2);
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it("starts 12 simultaneous streams before any response is released or completes", async () => {
    configValues["omnicopilot"] = { fallbackMode: "sameModel" };

    const context = mockContext();
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context, log: mockLog, onRequestEnd });
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let signalAllEntered!: () => void;
    const allEntered = new Promise<void>((resolve) => {
      signalAllEntered = resolve;
    });
    let entered = 0;
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        entered += 1;
        if (entered === 12) signalAllEntered();
        await streamGate;
        yield { kind: "text", text: "done" };
      }),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );

    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
    let completed = 0;
    const responses = Array.from({ length: 12 }, () =>
      provider.provideLanguageModelChatResponse(
        model,
        [],
        {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
        { report: vi.fn() } as unknown as vscode.Progress<unknown>,
        dummyToken
      ).then(() => {
        completed += 1;
      })
    );

    await allEntered;
    expect(client.streamModel).toHaveBeenCalledTimes(12);
    expect(entered).toBe(12);
    expect(completed).toBe(0);

    releaseStream();
    await Promise.all(responses);
    expect(completed).toBe(12);
    expect(onRequestEnd).toHaveBeenCalledTimes(12);
    expect(onRequestEnd).toHaveBeenCalledWith(true, undefined, 0);
  });

  it("prioritizes non-cooling fallback routes over routes currently in cooldown", async () => {
    configValues["omnicopilot"] = { retriesPerServer: 1, fallbackMode: "full" };

    const context = mockContext();
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context, log: mockLog, onRequestEnd });

    // Mark server B in cooldown
    routesModule.markRouteCooldown("B", 30_000, 429, "Throttled");

    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("Server A failed", undefined);
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(() => streamText("from B")),
    };
    const clientC = {
      baseUrl: "http://server-c.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(() => streamText("from C")),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
      { id: "C", name: "Server C", baseUrl: "http://server-c.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => {
        if (route.id === "A") return clientA;
        if (route.id === "B") return clientB;
        return clientC;
      }) as unknown as typeof routesModule.getClientForRoute
    );

    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    // Primary (A) failed, then healthy non-cooling Server C was chosen before cooling Server B!
    expect(clientA.streamModel).toHaveBeenCalled();
    expect(clientC.streamModel).toHaveBeenCalled();
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "from C" })
    );
  });

  it("deprioritizes a selected primary in cooldown behind a healthy same-model fallback", async () => {
    configValues["omnicopilot"] = { retriesPerServer: 1, fallbackMode: "sameModel" };
    routesModule.markRouteCooldown("A", 30_000, 429, "Throttled");
    const provider = new OmniRouteChatProvider({
      context: mockContext(),
      log: mockLog,
      getOnlineRouteIds: () => new Set(["B"]),
    });
    const callOrder: string[] = [];
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(() => {
        callOrder.push("A");
        return streamText("cooling primary answered");
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(() => {
        callOrder.push("B");
        return streamText("healthy fallback answered");
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => route.id === "A" ? clientA : clientB) as unknown as typeof routesModule.getClientForRoute
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    expect(callOrder).toEqual(["B"]);
    expect(clientB.streamModel).toHaveBeenCalledTimes(1);
    expect(clientA.streamModel).not.toHaveBeenCalled();
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "healthy fallback answered" })
    );
  });

  it("keeps a cooling exact-model route ahead of a healthy lower-quality fallback", async () => {
    configValues["omnicopilot"] = { retriesPerServer: 0, fallbackMode: "full" };
    routesModule.markRouteCooldown("A", 30_000, 429, "Throttled");
    const provider = new OmniRouteChatProvider({
      context: mockContext(),
      log: mockLog,
      getOnlineRouteIds: () => new Set(["B"]),
    });
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(() => streamText("exact model answered")),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "anthropic/claude-haiku" }]),
      streamModel: vi.fn().mockImplementation(() => streamText("lower quality answered")),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => route.id === "A" ? clientA : clientB) as unknown as typeof routesModule.getClientForRoute
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      { id: "Server A · openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as never,
      [],
      {} as never,
      progress as never,
      dummyToken
    );

    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientA.streamModel.mock.calls[0][0]).toMatchObject({ model: "openai/gpt-4o" });
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ value: "exact model answered" }));
  });

  it("merges repeated partial usage snapshots without additive double-counting", async () => {
    configValues["omnicopilot"] = { retriesPerServer: 1, fallbackMode: "sameModel" };
    const onUsage = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onUsage });
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        yield { kind: "usage", usage: { inputTokens: 100, cachedTokens: 25 } };
        yield { kind: "usage", usage: { inputTokens: 100, outputTokens: 10 } };
        yield { kind: "usage", usage: { outputTokens: 14 } };
        yield { kind: "text", text: "done" };
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      { report: vi.fn() } as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      routeId: "A",
      baseUrl: "http://server-a.local/v1",
      serverName: "Server A",
      modelName: "openai/gpt-4o",
      inputTokens: 100,
      outputTokens: 14,
      cachedTokens: 25,
      inputTokenProvenance: "reported",
      outputTokenProvenance: "reported",
    });
  });
});