import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { setMockConfig, setMockInspect } from "./vscode.mock";
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
