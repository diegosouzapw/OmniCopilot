import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { setMockConfig } from "./vscode.mock";
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
  isLoopbackOrigin,
  originOf,
  showUpgradeNoticeOnce,
  upgradeNotice,
} from "../src/connection";

/** An extension context whose SecretStorage and globalState are plain maps. */
function fakeContext(state: Record<string, unknown> = {}) {
  const secrets = new Map<string, string>();
  const global = new Map<string, unknown>(Object.entries(state));
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

describe("upgradeNotice", () => {
  it("says nothing on a fresh install", () => {
    expect(upgradeNotice({ welcomed: false, noticeVersion: undefined, hasStoredKey: true })).toBe("none");
    expect(upgradeNotice({ welcomed: false, noticeVersion: undefined, hasStoredKey: false })).toBe("none");
  });

  it("announces the change once to an existing install, naming the key when one is stored", () => {
    expect(upgradeNotice({ welcomed: true, noticeVersion: undefined, hasStoredKey: true })).toBe("with-key");
    expect(upgradeNotice({ welcomed: true, noticeVersion: undefined, hasStoredKey: false })).toBe(
      "without-key"
    );
    expect(upgradeNotice({ welcomed: true, noticeVersion: "1.3.0", hasStoredKey: false })).toBe(
      "without-key"
    );
  });

  it("says nothing once the 1.4.0 notice was shown", () => {
    expect(upgradeNotice({ welcomed: true, noticeVersion: "1.4.0", hasStoredKey: true })).toBe("none");
  });
});

describe("showUpgradeNoticeOnce", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tells an existing install where the URL now comes from, once, and offers the panel", async () => {
    setMockConfig({ baseUrl: "https://omni.example/v1" });
    const context = fakeContext({ "omnicopilot.welcomed": true });
    await context.secrets.store(SECRET_API_KEY, "sk-1");
    const info = vi
      .spyOn(vscode.window, "showInformationMessage")
      .mockResolvedValue("Open panel" as never);
    const run = vi.spyOn(vscode.commands, "executeCommand");

    await showUpgradeNoticeOnce(context);
    await showUpgradeNoticeOnce(context);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual([
      "OmniRoute now reads the server URL only from your user settings. It is https://omni.example, and a URL set in a workspace's settings is no longer used. Your API key is tied to that server.",
      "Open panel",
    ]);
    expect(run).toHaveBeenCalledWith("omnicopilot.manage");
    expect(context.globalState.get("omnicopilot.noticeVersion")).toBe("1.4.0");
  });

  it("leaves the key sentence out when no key is stored", async () => {
    setMockConfig({});
    const context = fakeContext({ "omnicopilot.welcomed": true });
    const info = vi.spyOn(vscode.window, "showInformationMessage");

    await showUpgradeNoticeOnce(context);

    expect(info.mock.calls[0][0]).toBe(
      "OmniRoute now reads the server URL only from your user settings. It is http://localhost:20128, and a URL set in a workspace's settings is no longer used."
    );
  });

  it("only sets the marker on a fresh install", async () => {
    setMockConfig({});
    const context = fakeContext({});
    const info = vi.spyOn(vscode.window, "showInformationMessage");

    await showUpgradeNoticeOnce(context);

    expect(info).not.toHaveBeenCalled();
    expect(context.globalState.get("omnicopilot.noticeVersion")).toBe("1.4.0");
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
