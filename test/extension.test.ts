import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registeredCommands, setMockConfig } from "./vscode.mock";
import { activate, deactivate } from "../src/extension";

const LINK_PAYLOAD =
  "[http://localhost:20128](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22x%22%7D)";

/** Activate the extension against the mock, as an install that was already welcomed. */
function activated() {
  const secrets = new Map<string, string>();
  const state = new Map<string, unknown>([["omnicopilot.welcomed", true]]);
  const memento = (store: Map<string, unknown>) => ({
    get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void store.set(key, value),
  });
  const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    extension: { packageJSON: { version: "test" } },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    globalState: memento(state),
    workspaceState: memento(new Map()),
  };
  activate(context as unknown as vscode.ExtensionContext);
  return {
    run: (id: string) => registeredCommands.get(id)?.(),
    dispose: () => {
      for (const item of context.subscriptions) item.dispose();
      deactivate();
    },
  };
}

describe("extension notifications built from the server URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not let the URL become a link in "Connected to OmniRoute at {0}."', async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    setMockConfig({ baseUrl: LINK_PAYLOAD });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const ext = activated();

    await ext.run("omnicopilot.checkConnection");

    const connected = info.mock.calls.map((call) => String(call[0])).find((text) => text.startsWith("Connected"));
    expect(connected).toBeDefined();
    expect(connected).not.toContain("](");
    ext.dispose();
  });

  it("does not let the URL become a link in the could-not-connect warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
      })
    );
    setMockConfig({ baseUrl: LINK_PAYLOAD });
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated();

    await ext.run("omnicopilot.checkConnection");

    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain("](");
    ext.dispose();
  });
});
