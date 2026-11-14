import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConfigurationTarget, configUpdates, setMockConfig, setMockInspect } from "./vscode.mock";
import { OmniRouteClient } from "../src/client";
import type { ProbeResult } from "../src/diagnostics";
import { OmniPanelProvider } from "../src/panel";

function fakeContext() {
  const secrets = new Map<string, string>();
  return {
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    globalState: { get: () => undefined, update: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
  } as unknown as vscode.ExtensionContext;
}

/** A panel whose webview only records the messages it is sent. */
function openPanel() {
  const posted: Array<Record<string, unknown>> = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const panel = new OmniPanelProvider(
    fakeContext(),
    log as unknown as vscode.LogOutputChannel,
    async () => undefined
  );
  (panel as unknown as { view: unknown }).view = {
    webview: { postMessage: async (message: Record<string, unknown>) => void posted.push(message) },
  };
  return { panel, posted };
}

const offline: ProbeResult = { ok: false, failure: "refused" };

describe("panel status", () => {
  afterEach(() => vi.restoreAllMocks());

  it("notes a server URL set in the workspace's settings, which is ignored", async () => {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    setMockConfig({ baseUrl: "https://user.example" });
    setMockInspect("baseUrl", { workspaceValue: "https://ws.example" });
    const { panel, posted } = openPanel();

    await panel.refreshStatus();

    expect(posted[0]).toMatchObject({
      url: "https://user.example",
      urlNote: "This workspace's settings set another server URL (https://ws.example). It is ignored.",
    });
  });

  it("has no note when the workspace sets nothing", async () => {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    setMockConfig({ baseUrl: "https://user.example" });
    const { panel, posted } = openPanel();

    await panel.refreshStatus();

    expect(posted[0]?.urlNote).toBeUndefined();
  });
});

describe("panel status ordering", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drops a status that finishes after a newer one", async () => {
    const pending: Array<(result: ProbeResult) => void> = [];
    vi.spyOn(OmniRouteClient.prototype, "probe").mockImplementation(
      () => new Promise<ProbeResult>((resolve) => void pending.push(resolve))
    );
    const { panel, posted } = openPanel();

    setMockConfig({ baseUrl: "http://192.168.0.1" }); // half-typed URL, slow probe
    const first = panel.refreshStatus();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    setMockConfig({ baseUrl: "http://192.168.0.15:20128" }); // the URL the user ended on
    const second = panel.refreshStatus();
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    pending[1](offline);
    await second;
    pending[0](offline);
    await first;

    expect(posted.map((status) => status.url)).toEqual(["http://192.168.0.15:20128"]);
  });
});

describe("panel Save", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A panel whose SecretStorage writes note how many settings writes came before them. */
  function savingPanel() {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    const secrets = new Map<string, string>();
    const writes: Array<{ name: string; value: string; settingsWritesBefore: number }> = [];
    const context = {
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => {
          secrets.set(key, value);
          writes.push({ name: key, value, settingsWritesBefore: configUpdates.length });
        },
        delete: async (key: string) => void secrets.delete(key),
      },
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
    } as unknown as vscode.ExtensionContext;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const panel = new OmniPanelProvider(context, log as unknown as vscode.LogOutputChannel, async () => undefined);
    const save = (url: string, apiKey: string) =>
      (panel as unknown as { handleMessage(m: Record<string, unknown>): Promise<void> }).handleMessage({
        type: "save",
        url,
        apiKey,
      });
    return { secrets, writes, save };
  }

  it("approves the typed URL for a new key before writing the setting", async () => {
    setMockConfig({ baseUrl: "https://a.example" });
    const { writes, save } = savingPanel();

    await save("https://b.example/", "sk-1");

    const approval = writes.find(
      (w) => w.name === "omnicopilot.apiKeyOrigins" && w.value === JSON.stringify(["https://b.example"])
    );
    expect(approval?.settingsWritesBefore).toBe(0);
    expect(configUpdates).toEqual([
      { key: "baseUrl", value: "https://b.example", target: ConfigurationTarget.Global },
    ]);
  });

  it("approves the typed URL for the stored key before writing the setting", async () => {
    setMockConfig({ baseUrl: "https://a.example" });
    const { secrets, writes, save } = savingPanel();
    secrets.set("omnicopilot.apiKey", "sk-1");
    secrets.set("omnicopilot.apiKeyOrigins", JSON.stringify(["https://a.example"]));

    await save("https://b.example", "");

    const approval = writes.find((w) => w.name === "omnicopilot.apiKeyOrigins");
    expect(approval?.value).toBe(JSON.stringify(["https://a.example", "https://b.example"]));
    expect(approval?.settingsWritesBefore).toBe(0);
    expect(configUpdates).toHaveLength(1);
  });

  it("leaves the URL setting alone when only a key is saved", async () => {
    setMockConfig({ baseUrl: "https://a.example" });
    const { secrets, save } = savingPanel();

    await save("https://a.example", "sk-1");

    expect(configUpdates).toEqual([]);
    expect(secrets.get("omnicopilot.apiKey")).toBe("sk-1");
    expect(secrets.get("omnicopilot.apiKeyOrigins")).toBe(JSON.stringify(["https://a.example"]));
  });
});

/** A webview view that records what the panel sets and lets the test post messages to it. */
function fakeView() {
  let onMessage: ((msg: Record<string, unknown>) => Promise<void>) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const view = {
    visible: true,
    webview: {
      options: {},
      html: "",
      onDidReceiveMessage: (cb: (msg: Record<string, unknown>) => Promise<void>) => {
        onMessage = cb;
        return { dispose() {} };
      },
      postMessage: async (message: Record<string, unknown>) => void posted.push(message),
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
  };
  return {
    view: view as unknown as vscode.WebviewView,
    posted,
    send: (msg: Record<string, unknown>) => onMessage?.(msg),
  };
}

describe("panel errors in notifications", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not let an error message become a link", async () => {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    const shown = vi.spyOn(vscode.window, "showErrorMessage");
    setMockConfig({ baseUrl: "https://user.example" });
    const context = {
      secrets: {
        get: async () => undefined,
        store: async () => undefined,
        delete: async () => {
          throw new Error(
            "[http://localhost:20128](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22x%22%7D)"
          );
        },
      },
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
    } as unknown as vscode.ExtensionContext;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const panel = new OmniPanelProvider(context, log as unknown as vscode.LogOutputChannel, async () => undefined);
    const { view, send } = fakeView();
    panel.resolveWebviewView(view);

    await send({ type: "clearKey" });

    expect(shown).toHaveBeenCalledTimes(1);
    expect(String(shown.mock.calls[0][0])).toMatch(/^OmniRoute: /);
    expect(String(shown.mock.calls[0][0])).not.toContain("](");
  });
});

describe("panel document", () => {
  it("builds no markup from strings at run time", () => {
    const { view } = fakeView();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    new OmniPanelProvider(fakeContext(), log as unknown as vscode.LogOutputChannel, async () => undefined)
      .resolveWebviewView(view);
    const html = (view.webview as unknown as { html: string }).html;
    expect(html.length).toBeGreaterThan(1000);
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(html, sink).not.toContain(sink);
    }
    vi.restoreAllMocks();
  });
});

describe("panel status refresh that fails", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the failure and tells the panel instead of leaving it on Checking…", async () => {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    setMockConfig({ baseUrl: "https://user.example" });
    const context = {
      secrets: {
        get: async () => {
          throw new Error("keychain locked");
        },
        store: async () => undefined,
        delete: async () => undefined,
      },
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
    } as unknown as vscode.ExtensionContext;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const panel = new OmniPanelProvider(context, log as unknown as vscode.LogOutputChannel, async () => undefined);
    const posted: Array<Record<string, unknown>> = [];
    (panel as unknown as { view: unknown }).view = {
      webview: { postMessage: async (message: Record<string, unknown>) => void posted.push(message) },
    };

    await expect(panel.refreshStatus()).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("keychain locked"));
    expect(posted).toEqual([{ type: "statusError", detail: "OmniRoute: Error: keychain locked" }]);
  });

  it("renders the failure in the panel script", () => {
    const { view } = fakeView();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    new OmniPanelProvider(fakeContext(), log as unknown as vscode.LogOutputChannel, async () => undefined)
      .resolveWebviewView(view);
    const html = (view.webview as unknown as { html: string }).html;
    expect(html).toContain('msg.type === "statusError"');
    expect(html).toContain("Could not read the connection status.");
  });
});
