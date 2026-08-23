import * as vscode from "vscode";
import { DEFAULT_BASE_URL, OmniRouteClient, serverRootUrl } from "./client";
import { SECRET_API_KEY } from "./provider";

interface PanelStatus {
  type: "status";
  online: boolean;
  url: string;
  modelCount: number | null;
  hasKey: boolean;
  detail?: string;
}

/** Sidebar webview: connection status, server URL and API key form,
 * plus the extension's quick actions — the visual home of the extension. */
export class OmniPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "omnicopilot.panel";

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly onSettingsSaved: () => Promise<void>
  ) {}

  /** Reveal the panel (used by the managementCommand / status bar). */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${OmniPanelProvider.viewId}.focus`);
  }

  /** Push a fresh status snapshot into the webview, if it is open. */
  async refreshStatus(): Promise<void> {
    if (!this.view) return;
    void this.view.webview.postMessage(await this.buildStatus());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();

    view.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      try {
        await this.handleMessage(msg);
      } catch (err) {
        this.log.error(`Panel message failed: ${String(err)}`);
        void vscode.window.showErrorMessage(`OmniRoute: ${String(err)}`);
      }
    });

    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refreshStatus();
    });

    void this.refreshStatus();
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "ready":
      case "test":
        await this.refreshStatus();
        break;

      case "save": {
        // Store the server root; `/v1` is appended per request by the client.
        const url = serverRootUrl(String(msg.url ?? ""));
        await vscode.workspace
          .getConfiguration("omnicopilot")
          .update("baseUrl", url, vscode.ConfigurationTarget.Global);

        // Empty key field = keep the stored key; the explicit Clear button removes it.
        const key = String(msg.apiKey ?? "").trim();
        if (key) {
          await this.context.secrets.store(SECRET_API_KEY, key);
          this.log.info("API key stored via panel");
        }

        await this.onSettingsSaved();
        await this.refreshStatus();
        break;
      }

      case "clearKey":
        await this.context.secrets.delete(SECRET_API_KEY);
        this.log.info("API key cleared via panel");
        await this.onSettingsSaved();
        await this.refreshStatus();
        break;

      case "action":
        await vscode.commands.executeCommand(String(msg.command));
        break;
    }
  }

  private async buildStatus(): Promise<PanelStatus> {
    const url = vscode.workspace
      .getConfiguration("omnicopilot")
      .get<string>("baseUrl", DEFAULT_BASE_URL);
    const apiKey = await this.context.secrets.get(SECRET_API_KEY);
    const client = new OmniRouteClient({ baseUrl: url, apiKey: apiKey || undefined });

    const online = await client.ping(3000);
    let modelCount: number | null = null;
    let detail: string | undefined;
    if (online) {
      try {
        modelCount = (await client.listModels()).length;
      } catch (err) {
        detail = String(err instanceof Error ? err.message : err);
      }
    }

    return {
      type: "status",
      online,
      url: serverRootUrl(url),
      modelCount,
      hasKey: Boolean(apiKey),
      detail,
    };
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const t = vscode.l10n.t;
    const S = {
      checking: t("Checking…"),
      testing: t("Testing…"),
      serverUrl: t("Server URL"),
      apiKey: t("API key"),
      keyPlaceholder: t("paste your OmniRoute API key"),
      saveTest: t("Save & Test"),
      clearKey: t("Clear key"),
      clearKeyTitle: t("Remove the stored API key"),
      keyStored: t("A key is stored in the OS keychain. Leave the field empty to keep it."),
      keyNone: t("No key stored — only needed when your OmniRoute requires one."),
      onlineWithCount: t("Online — {0} models available"),
      online: t("Online"),
      onlineBlocked: t("Online (models blocked)"),
      offline: t("Offline — server unreachable"),
      linkRefresh: t("Refresh models in the picker"),
      linkDashboard: t("Open OmniRoute dashboard"),
      linkCli: t("Configure a coding CLI (Codex, Claude Code…)"),
      linkInstall: t("Install OmniRoute"),
      linkGitHub: t("OmniRoute on GitHub"),
      linkSettings: t("Extension settings"),
    };
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px 14px; }
  h3 { margin: 4px 0 10px; font-size: 13px; display: flex; align-items: center; gap: 7px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-charts-red); display: inline-block; }
  .dot.on { background: var(--vscode-charts-green); }
  .muted { color: var(--vscode-descriptionForeground); font-size: 11.5px; margin: 2px 0 12px; word-break: break-all; }
  label { display: block; font-size: 11px; margin: 10px 0 3px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; }
  input { width: 100%; box-sizing: border-box; padding: 5px 7px; border-radius: 3px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); outline: none; }
  input:focus { border-color: var(--vscode-focusBorder); }
  .row { display: flex; gap: 6px; margin-top: 12px; }
  button { flex: 1; padding: 5px 8px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .links { margin-top: 16px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); padding-top: 8px; }
  .link { display: block; padding: 5px 2px; cursor: pointer; font-size: 12.5px; color: var(--vscode-textLink-foreground); }
  .link:hover { text-decoration: underline; }
  .badge { font-weight: 600; }
  .warn { color: var(--vscode-charts-orange); font-size: 11.5px; margin-top: 8px; word-break: break-word; }
  .keyhint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
</style>
</head>
<body>
  <h3><span id="dot" class="dot"></span><span id="statusText">${S.checking}</span></h3>
  <div class="muted" id="urlText"></div>

  <label for="url">${S.serverUrl}</label>
  <input id="url" type="text" placeholder="${DEFAULT_BASE_URL}" />

  <label for="key">${S.apiKey}</label>
  <input id="key" type="password" placeholder="${S.keyPlaceholder}" />
  <div class="keyhint" id="keyHint"></div>

  <div class="row">
    <button id="save">${S.saveTest.replace("&", "&amp;")}</button>
    <button id="clearKey" class="secondary" title="${S.clearKeyTitle}">${S.clearKey}</button>
  </div>
  <div class="warn" id="detail" style="display:none"></div>

  <div class="links">
    <span class="link" data-cmd="omnicopilot.refreshModels">↻ ${S.linkRefresh}</span>
    <span class="link" data-cmd="omnicopilot.openDashboard">▤ ${S.linkDashboard}</span>
    <span class="link" data-cmd="omnicopilot.configureCliTool">⌨ ${S.linkCli}</span>
    <span class="link" data-cmd="omnicopilot.installOmniRoute">⇩ ${S.linkInstall}</span>
    <span class="link" data-cmd="omnicopilot.openGitHub">★ ${S.linkGitHub}</span>
    <span class="link" data-cmd="omnicopilot.openSettings">⚙ ${S.linkSettings}</span>
  </div>

  <script nonce="${nonce}">
    const S = ${JSON.stringify(S)};
    const vscodeApi = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    $("save").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "save", url: $("url").value, apiKey: $("key").value });
      $("key").value = "";
      $("statusText").textContent = S.testing;
    });
    $("clearKey").addEventListener("click", () => vscodeApi.postMessage({ type: "clearKey" }));
    document.querySelectorAll(".link").forEach((el) =>
      el.addEventListener("click", () => vscodeApi.postMessage({ type: "action", command: el.dataset.cmd }))
    );

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type !== "status") return;
      $("dot").className = "dot" + (msg.online ? " on" : "");
      if (!$("url").value) $("url").value = msg.url;
      $("urlText").textContent = msg.url;
      $("keyHint").textContent = msg.hasKey ? S.keyStored : S.keyNone;
      const st = $("statusText");
      st.textContent = "";
      if (msg.online) {
        if (msg.modelCount !== null) {
          // Localized pattern with {0} for the count; badge-wrap the number.
          const [prefix, suffix] = S.onlineWithCount.split("{0}");
          st.append(prefix ?? "");
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = String(msg.modelCount);
          st.append(badge, suffix ?? "");
        } else {
          st.textContent = msg.detail ? S.onlineBlocked : S.online;
        }
      } else {
        st.textContent = S.offline;
      }
      const d = $("detail");
      if (msg.detail) { d.textContent = msg.detail; d.style.display = "block"; }
      else { d.style.display = "none"; }
    });

    vscodeApi.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
