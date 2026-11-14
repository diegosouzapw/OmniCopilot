import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { setMockConfig } from "./vscode.mock";
import {
  SECRET_API_KEY,
  decideKeyUse,
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
    expect(decideKeyUse({ storedKey: "", boundOrigin: local, currentOrigin: local })).toEqual({
      apiKey: undefined,
      keyWithheld: false,
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
    expect(decideKeyUse({ storedKey: "sk-1", boundOrigin: local, currentOrigin: local })).toEqual({
      apiKey: "sk-1",
      keyWithheld: false,
      bindNow: false,
    });
  });

  it("withholds a key bound to another origin", () => {
    expect(
      decideKeyUse({
        storedKey: "sk-1",
        boundOrigin: local,
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
