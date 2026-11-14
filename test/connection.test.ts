import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { setMockConfig, setMockInspect } from "./vscode.mock";
import {
  SECRET_API_KEY,
  SECRET_API_KEY_ORIGINS,
  clearApiKey,
  decideKeyUse,
  keyWithheldMessage,
  parseApprovedOrigins,
  rebindApiKey,
  resolveConnection,
  storeApiKey,
  warnIfKeyWithheld,
  createWithheldKeyWatcher,
  isLoopbackOrigin,
  originOf,
  ignoredWorkspaceUrl,
  showIgnoredWorkspaceUrlNotice,
  userLevelBaseUrl,
} from "../src/connection";

/** An extension context whose SecretStorage and globalState are plain maps. */
function fakeContext(state: Record<string, unknown> = {}) {
  const secrets = new Map<string, string>();
  const global = new Map<string, unknown>(Object.entries(state));
  const local = new Map<string, unknown>();
  const context = {
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    globalState: {
      get: <T>(key: string, fallback?: T) => (global.has(key) ? (global.get(key) as T) : fallback),
      update: async (key: string, value: unknown) => {
        if (value === undefined) global.delete(key);
        else global.set(key, value);
      },
    },
    workspaceState: {
      get: <T>(key: string, fallback?: T) => (local.has(key) ? (local.get(key) as T) : fallback),
      update: async (key: string, value: unknown) => {
        if (value === undefined) local.delete(key);
        else local.set(key, value);
      },
    },
  };
  return Object.assign(context as unknown as vscode.ExtensionContext, {
    secretMap: secrets,
    stateMap: global,
  });
}

describe("originOf", () => {
  it.each([
    ["http://LocalHost:20128/v1/", "http://localhost:20128"],
    ["localhost:20128", "http://localhost:20128"],
    ["https://Example.com/v1", "https://example.com"],
    ["http://[::1]:20128/", "http://[::1]:20128"],
    ["https://example.com:8443/some/path", "https://example.com:8443"],
    ["", "http://localhost:20128"],
  ])("reduces %s to scheme, lower-case host and port", (input, expected) => {
    expect(originOf(input)).toBe(expected);
  });

  it("ignores the path, so /v1 or no /v1 yields the same origin", () => {
    expect(originOf("https://example.com")).toBe(originOf("https://example.com/v1/"));
  });
});

describe("isLoopbackOrigin", () => {
  it.each([
    "http://localhost:20128",
    "http://127.0.0.1:20128",
    "http://127.1.2.3:20128",
    "http://[::1]:20128",
    "https://localhost",
  ])("recognises %s as loopback", (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(true);
  });

  it.each([
    "http://192.168.0.4:20128",
    "https://example.com",
    "http://localhost.evil.example",
    "http://127.0.0.1.evil.example",
    "http://127.0.0.256:20128",
    "not a url",
  ])("does not treat %s as loopback", (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(false);
  });
});

describe("decideKeyUse", () => {
  const local = "http://localhost:20128";

  it("sends no key when none is stored", () => {
    expect(decideKeyUse({ currentOrigin: local })).toEqual({
      apiKey: undefined,
      keyWithheld: false,
      bindNow: false,
    });
  });

  it("treats an empty stored key as no key", () => {
    expect(decideKeyUse({ storedKey: "", approvedOrigins: [local], currentOrigin: local })).toEqual({
      apiKey: undefined,
      keyWithheld: false,
      bindNow: false,
    });
  });

  it("uses a key approved for several origins at any of them", () => {
    expect(
      decideKeyUse({
        storedKey: "sk-1",
        approvedOrigins: ["https://a.example", local],
        currentOrigin: local,
      })
    ).toEqual({ apiKey: "sk-1", keyWithheld: false, bindNow: false });
  });

  it("withholds a key whose approved list is empty (a malformed value reads as empty)", () => {
    expect(decideKeyUse({ storedKey: "sk-1", approvedOrigins: [], currentOrigin: local })).toEqual({
      apiKey: undefined,
      keyWithheld: true,
      bindNow: false,
    });
  });

  it("uses a key that was never bound and asks to bind it now", () => {
    expect(decideKeyUse({ storedKey: "sk-1", currentOrigin: local })).toEqual({
      apiKey: "sk-1",
      keyWithheld: false,
      bindNow: true,
    });
  });

  it("uses a key bound to the current origin", () => {
    expect(decideKeyUse({ storedKey: "sk-1", approvedOrigins: [local], currentOrigin: local })).toEqual({
      apiKey: "sk-1",
      keyWithheld: false,
      bindNow: false,
    });
  });

  it("withholds a key bound to another origin", () => {
    expect(
      decideKeyUse({
        storedKey: "sk-1",
        approvedOrigins: [local],
        currentOrigin: "https://evil.example",
      })
    ).toEqual({ apiKey: undefined, keyWithheld: true, bindNow: false });
  });
});

describe("userLevelBaseUrl", () => {
  it("uses the user-level value, then the default, then the built-in default", () => {
    expect(userLevelBaseUrl({ globalValue: "https://u.example", defaultValue: "http://d:1" })).toBe(
      "https://u.example"
    );
    expect(userLevelBaseUrl({ globalValue: "", defaultValue: "http://d:1" })).toBe("http://d:1");
    expect(userLevelBaseUrl({ globalValue: "   ", defaultValue: "http://d:1" })).toBe("http://d:1");
    expect(userLevelBaseUrl({ globalValue: 42, defaultValue: "http://d:1" })).toBe("http://d:1");
    expect(userLevelBaseUrl({ globalValue: 42 })).toBe("http://localhost:20128");
    expect(userLevelBaseUrl(undefined)).toBe("http://localhost:20128");
  });
});

describe("resolveConnection reads the server URL from the user level only", () => {
  it.each([
    ["a workspace value", { workspaceValue: "https://ws.example" }],
    ["a folder value", { workspaceFolderValue: "https://folder.example" }],
    ["a language-specific value", { workspaceLanguageValue: "https://l.example", globalLanguageValue: "https://gl.example", defaultLanguageValue: "https://dl.example", workspaceFolderLanguageValue: "https://fl.example" }],
  ])("ignores %s", async (_name, fields) => {
    setMockConfig({});
    setMockInspect("baseUrl", { defaultValue: "http://localhost:20128", ...fields });
    expect((await resolveConnection(fakeContext())).baseUrl).toBe("http://localhost:20128/v1");
  });

  it("uses the user-level value over a workspace value", async () => {
    setMockConfig({ baseUrl: "https://user.example" });
    setMockInspect("baseUrl", { workspaceValue: "https://ws.example" });
    const connection = await resolveConnection(fakeContext());
    expect(connection.baseUrl).toBe("https://user.example/v1");
    expect(connection.ignoredWorkspaceUrl).toBe("https://ws.example");
  });

  it.each([[""], [42], [null]])("falls back to the default for the user value %j", async (value) => {
    setMockConfig({ baseUrl: value });
    setMockInspect("baseUrl", { defaultValue: "http://localhost:20128" });
    expect((await resolveConnection(fakeContext())).baseUrl).toBe("http://localhost:20128/v1");
  });
});

describe("ignoredWorkspaceUrl", () => {
  const effectiveRoot = "http://localhost:20128";

  it("names the folder value first, then the workspace value", () => {
    expect(
      ignoredWorkspaceUrl({
        workspaceValue: "https://ws.example",
        workspaceFolderValue: "https://folder.example",
        effectiveRoot,
      })
    ).toBe("https://folder.example");
    expect(ignoredWorkspaceUrl({ workspaceValue: "https://ws.example", effectiveRoot })).toBe(
      "https://ws.example"
    );
  });

  it("says nothing when the value equals the effective URL after normalisation", () => {
    expect(ignoredWorkspaceUrl({ workspaceValue: "localhost:20128/v1/", effectiveRoot })).toBeUndefined();
    expect(
      ignoredWorkspaceUrl({
        workspaceValue: "https://ws.example",
        workspaceFolderValue: " http://localhost:20128 ",
        effectiveRoot,
      })
    ).toBeUndefined();
  });

  it("says nothing without a non-empty string", () => {
    expect(ignoredWorkspaceUrl({ effectiveRoot })).toBeUndefined();
    expect(ignoredWorkspaceUrl({ workspaceValue: "", workspaceFolderValue: "  ", effectiveRoot })).toBeUndefined();
    expect(ignoredWorkspaceUrl({ workspaceValue: 42, effectiveRoot })).toBeUndefined();
  });
});

describe("showIgnoredWorkspaceUrlNotice", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tells the user once per ignored value, and again when it changes", async () => {
    setMockConfig({ baseUrl: "https://user.example" });
    setMockInspect("baseUrl", { workspaceValue: "https://ws.example" });
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue("Open panel" as never);
    const run = vi.spyOn(vscode.commands, "executeCommand");
    const context = fakeContext();

    await showIgnoredWorkspaceUrlNotice(context);
    await showIgnoredWorkspaceUrlNotice(context);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual([
      "This workspace's settings set an OmniRoute server URL (https://ws.example). It is not used: the server URL is read from your user settings, and it is https://user.example.",
      "Open panel",
    ]);
    expect(run).toHaveBeenCalledWith("omnicopilot.manage");
    expect(context.workspaceState.get("omnicopilot.ignoredUrlNotice")).toBe("https://ws.example");

    setMockInspect("baseUrl", { workspaceValue: "https://other.example" });
    await showIgnoredWorkspaceUrlNotice(context);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1][0]).toContain("(https://other.example)");
  });

  it("says nothing when no workspace value differs from the user-level URL", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    setMockConfig({ baseUrl: "https://user.example" });
    await showIgnoredWorkspaceUrlNotice(fakeContext());
    setMockInspect("baseUrl", { workspaceValue: "https://user.example/v1" });
    await showIgnoredWorkspaceUrlNotice(fakeContext());
    expect(info).not.toHaveBeenCalled();
  });
});

describe("parseApprovedOrigins", () => {
  it("reads a missing value as a key from before 1.4.0", () => {
    expect(parseApprovedOrigins(undefined)).toBeUndefined();
  });

  it("reads a JSON array of origins", () => {
    expect(parseApprovedOrigins('["https://a.example","http://localhost:20128"]')).toEqual([
      "https://a.example",
      "http://localhost:20128",
    ]);
  });

  it.each(["", "not json", "{}", '"https://a.example"', "null", "[1,2]"])(
    "reads the malformed value %j as an empty list, never as a legacy key",
    (raw) => {
      expect(parseApprovedOrigins(raw)).toEqual([]);
    }
  );
});

describe("key binding in SecretStorage", () => {
  const A = "https://a.example";
  const B = "https://b.example";
  afterEach(() => vi.restoreAllMocks());

  function origins(context: ReturnType<typeof fakeContext>): unknown {
    const raw = context.secretMap.get(SECRET_API_KEY_ORIGINS);
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  it("adopts a key from before 1.4.0 once and records the origin next to the key", async () => {
    setMockConfig({ baseUrl: `${A}/v1` });
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-1");

    const first = await resolveConnection(context);
    expect(first).toMatchObject({ apiKey: "sk-1", keyWithheld: false, approvedOrigins: [A] });
    expect(origins(context)).toEqual([A]);

    setMockConfig({ baseUrl: B });
    const second = await resolveConnection(context);
    expect(second).toMatchObject({ apiKey: undefined, keyWithheld: true, approvedOrigins: [A] });
    expect(origins(context)).toEqual([A]);
  });

  it("keeps the binding out of globalState", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-1");
    await resolveConnection(context);
    expect([...context.stateMap.keys()]).toEqual([]);
  });

  it("withholds the key in a window whose URL was never approved, and names the approved origin", async () => {
    setMockConfig({ baseUrl: B });
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-1");
    context.secretMap.set(SECRET_API_KEY_ORIGINS, JSON.stringify([A]));

    const connection = await resolveConnection(context);

    expect(connection).toMatchObject({ apiKey: undefined, keyWithheld: true, hasStoredKey: true });
    expect(keyWithheldMessage(connection)).toBe(
      `The stored API key was saved for ${A} and is not being sent to ${B}. Press Save & Test to use it here.`
    );
  });

  it("treats a malformed origins secret as an empty list: the key is withheld", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-1");
    context.secretMap.set(SECRET_API_KEY_ORIGINS, "{oops");

    expect(await resolveConnection(context)).toMatchObject({ apiKey: undefined, keyWithheld: true });
    expect(context.secretMap.get(SECRET_API_KEY_ORIGINS)).toBe("{oops");
  });

  it("releases the key to a changed URL only after rebindApiKey, keeping the old origin", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-1");
    setMockConfig({ baseUrl: B });
    expect((await resolveConnection(context)).apiKey).toBeUndefined();

    await rebindApiKey(context);

    expect((await resolveConnection(context)).apiKey).toBe("sk-1");
    expect(origins(context)).toEqual([A, B]);
    setMockConfig({ baseUrl: A });
    expect((await resolveConnection(context)).apiKey).toBe("sk-1");
  });

  it("keeps at most the five most recently approved origins, the newest last", async () => {
    const context = fakeContext();
    setMockConfig({ baseUrl: "https://o0.example" });
    await storeApiKey(context, "sk-1");
    for (let i = 1; i <= 6; i++) {
      setMockConfig({ baseUrl: `https://o${i}.example` });
      await rebindApiKey(context);
    }
    setMockConfig({ baseUrl: "https://o2.example" });
    await rebindApiKey(context);

    expect(origins(context)).toEqual([
      "https://o3.example",
      "https://o4.example",
      "https://o5.example",
      "https://o6.example",
      "https://o2.example",
    ]);
    setMockConfig({ baseUrl: "https://o1.example" });
    const connection = await resolveConnection(context);
    expect(connection.keyWithheld).toBe(true);
    expect(keyWithheldMessage(connection)).toContain("saved for https://o2.example");
  });

  it("does nothing on rebind when no key is stored", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await rebindApiKey(context);
    expect(context.secretMap.size).toBe(0);
  });

  it("resets the approved list to the current origin when a new key is stored", async () => {
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-old");
    context.secretMap.set(SECRET_API_KEY_ORIGINS, JSON.stringify([A, B]));
    setMockConfig({ baseUrl: "https://c.example" });

    await storeApiKey(context, "sk-new");

    expect(context.secretMap.get(SECRET_API_KEY)).toBe("sk-new");
    expect(origins(context)).toEqual(["https://c.example"]);
    setMockConfig({ baseUrl: A });
    expect((await resolveConnection(context)).apiKey).toBeUndefined();
  });

  it("removes the key and its approved origins together", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-1");

    await clearApiKey(context);

    expect(context.secretMap.has(SECRET_API_KEY)).toBe(false);
    expect(context.secretMap.has(SECRET_API_KEY_ORIGINS)).toBe(false);
    expect(await resolveConnection(context)).toMatchObject({ hasStoredKey: false, keyWithheld: false });
  });

  it("warns once per plain-HTTP origin outside this machine, also for an adopted key", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const lan = "http://192.168.0.4:20128";
    setMockConfig({ baseUrl: lan });
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-1");

    await resolveConnection(context); // adopts the legacy key
    await storeApiKey(context, "sk-2");
    await rebindApiKey(context);
    setMockConfig({ baseUrl: "http://localhost:20128" });
    await rebindApiKey(context);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      `The API key for ${lan} travels over plain HTTP. Anyone on the network path can read it. Prefer HTTPS or a tunnel for a server outside this machine.`
    );
  });
});

describe("warnIfKeyWithheld", () => {
  const A = "https://a.example";
  const B = "https://b.example";
  afterEach(() => vi.restoreAllMocks());

  async function keySavedForA() {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-1");
    return context;
  }

  it("warns once per origin when the URL moved away from the key", async () => {
    const context = await keySavedForA();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const warned = new Set<string>();
    setMockConfig({ baseUrl: `${B}/v1` });

    await warnIfKeyWithheld(context, warned, async () => undefined);
    await warnIfKeyWithheld(context, warned, async () => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      `The OmniRoute server URL is now ${B}. The stored API key was saved for ${A} and is not being sent to the new server.`,
      "Use the key here",
      "Open panel",
    ]);
  });

  it("says nothing while the key is sent, or when none is stored", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const context = await keySavedForA();
    await warnIfKeyWithheld(context, new Set(), async () => undefined);
    setMockConfig({ baseUrl: B });
    await warnIfKeyWithheld(fakeContext(), new Set(), async () => undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it("approves the new server and refreshes when the user picks Use the key here", async () => {
    const context = await keySavedForA();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Use the key here" as never);
    const refreshed = vi.fn(async () => undefined);
    setMockConfig({ baseUrl: B });

    await warnIfKeyWithheld(context, new Set(), refreshed);

    expect(refreshed).toHaveBeenCalledTimes(1);
    expect((await resolveConnection(context)).apiKey).toBe("sk-1");
  });

  it("opens the panel without approving anything on Open panel", async () => {
    const context = await keySavedForA();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Open panel" as never);
    const run = vi.spyOn(vscode.commands, "executeCommand");
    const refreshed = vi.fn(async () => undefined);
    setMockConfig({ baseUrl: B });

    await warnIfKeyWithheld(context, new Set(), refreshed);

    expect(run).toHaveBeenCalledWith("omnicopilot.manage");
    expect(refreshed).not.toHaveBeenCalled();
    expect((await resolveConnection(context)).keyWithheld).toBe(true);
  });
});

describe("approving the URL being saved", () => {
  it("binds a rebind or a new key to an explicit URL instead of the configured one", async () => {
    setMockConfig({ baseUrl: "https://a.example" });
    const context = fakeContext();
    await storeApiKey(context, "sk-1", "https://b.example/v1");
    expect(JSON.parse(context.secretMap.get(SECRET_API_KEY_ORIGINS) ?? "")).toEqual([
      "https://b.example",
    ]);
    await rebindApiKey(context, "c.example:8080");
    expect(JSON.parse(context.secretMap.get(SECRET_API_KEY_ORIGINS) ?? "")).toEqual([
      "https://b.example",
      "http://c.example:8080",
    ]);
  });
});

describe("createWithheldKeyWatcher", () => {
  const A = "https://a.example";
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function keySavedForA() {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-1");
    return context;
  }

  it("warns once, for the URL in effect when the edits settle", async () => {
    const context = await keySavedForA();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const watcher = createWithheldKeyWatcher(context, async () => undefined, () => undefined);

    for (const url of ["https://b", "https://b.ex", "https://b.example"]) {
      setMockConfig({ baseUrl: url });
      watcher.schedule();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("The OmniRoute server URL is now https://b.example.");
    watcher.dispose();
  });

  it("says nothing when the URL goes back to an approved one before it settles", async () => {
    const context = await keySavedForA();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const watcher = createWithheldKeyWatcher(context, async () => undefined, () => undefined);

    setMockConfig({ baseUrl: "https://b.example" });
    watcher.schedule();
    await vi.advanceTimersByTimeAsync(800);
    setMockConfig({ baseUrl: A });
    watcher.schedule();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();

    expect(warn).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("stops a pending check when disposed", async () => {
    const context = await keySavedForA();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const watcher = createWithheldKeyWatcher(context, async () => undefined, () => undefined);

    setMockConfig({ baseUrl: "https://b.example" });
    watcher.schedule();
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("storeApiKey write order", () => {
  it("never leaves the old key approved for the new server, nor the new key for the old ones", async () => {
    const A = "https://a.example";
    const B = "https://b.example";
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-old");
    context.secretMap.set(SECRET_API_KEY_ORIGINS, JSON.stringify([A]));
    setMockConfig({ baseUrl: B }); // changed in Settings: the old key is withheld here

    const snapshots: Array<{ key?: string; origins?: string[] }> = [];
    const store = context.secrets.store.bind(context.secrets);
    context.secrets.store = async (name: string, value: string) => {
      await store(name, value);
      snapshots.push({
        key: context.secretMap.get(SECRET_API_KEY),
        origins: parseApprovedOrigins(context.secretMap.get(SECRET_API_KEY_ORIGINS)),
      });
    };

    await storeApiKey(context, "sk-new");

    expect(snapshots.length).toBeGreaterThan(0);
    for (const { key, origins } of snapshots) {
      expect(key === "sk-old" && origins?.includes(B), JSON.stringify({ key, origins })).toBe(false);
      expect(key === "sk-new" && origins?.includes(A), JSON.stringify({ key, origins })).toBe(false);
      expect(key !== undefined && origins === undefined).toBe(false);
    }
    expect(snapshots.at(-1)).toEqual({ key: "sk-new", origins: [B] });
  });
});
