import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { formatErrorValue, normalizeBaseUrl } from "./client";
import { cachedLoadRoutes, getClientForRoute, saveRoutes } from "./routes";

interface RawRouteInput {
  id?: string;
  name?: string;
  url?: string;
  apiKey?: string;
}

type PanelMessage =
  | { type: "ready" | "test" }
  | { type: "save"; routes?: RawRouteInput[] }
  | { type: "action"; command?: string };

interface PanelRoute {
  id: string;
  name: string;
  url: string;
  hasKey: boolean;
  online: boolean;
  modelCount: number | null;
}


interface PanelStatus {
  type: "status";
  routes: PanelRoute[];
  onlineCount: number;
  total: number;
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

  /** Reveal the panel (used by the status bar / manage command). */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${OmniPanelProvider.viewId}.focus`);
  }

  /** Push a fresh status snapshot into the webview, if it is open. */
  async refreshStatus(): Promise<void> {
    if (!this.view) return;

    // 1. Instantly render saved routes so input fields load in 0ms
    try {
      const routes = await cachedLoadRoutes(this.context);
      const instantStatus: PanelStatus = {
        type: "status",
        routes: routes.map((r) => ({
          id: r.id,
          name: r.name,
          url: r.baseUrl,
          hasKey: Boolean(r.apiKey),
          online: false,
          modelCount: null,
        })),
        onlineCount: 0,
        total: routes.length,
      };
      void this.view.webview.postMessage(instantStatus);
    } catch (err) {
      this.log.debug(`Panel initial render error: ${formatErrorValue(err)}`);
    }

    // 2. Fast parallel probe for live status
    void this.view.webview.postMessage(await this.buildStatus());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    view.webview.html = this.html();

    view.webview.onDidReceiveMessage(async (msg: PanelMessage) => {
      try {
        await this.handleMessage(msg);
      } catch (err) {
        this.log.error(`Panel message failed: ${formatErrorValue(err)}`);
        void vscode.window.showErrorMessage(`OmniRoute: ${formatErrorValue(err)}`);
      }
    });

    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refreshStatus();
    });

    void this.refreshStatus();
  }

  private async handleMessage(msg: PanelMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
      case "test":
        await this.refreshStatus();
        break;

      case "save": {
        const incoming = Array.isArray(msg.routes) ? msg.routes : [];
        const routes: Array<{ id: string; name: string; baseUrl: string; apiKey?: string }> = [];
        for (const o of incoming) {
          if (!o || typeof o !== "object") continue;
          const key = String(o.apiKey ?? "").trim();
          routes.push({
            id: String(o.id ?? ""),
            name: String(o.name ?? "").trim() || "Route",
            baseUrl: normalizeBaseUrl(String(o.url ?? "")),
            ...(key ? { apiKey: key } : {}),
          });

        }
        if (routes.length === 0) break; // guard: never save an empty route list
        await saveRoutes(this.context, routes);
        this.log.info(`Saved ${routes.length} route(s) via panel`);
        await this.onSettingsSaved();
        await this.refreshStatus();
        break;
      }

      case "action": {
        const allowedCommands = new Set([
          "omnicopilot.openDashboard",
          "omnicopilot.manage",
          "omnicopilot.refreshModels",
          "omnicopilot.configureCliTool",
          "omnicopilot.checkConnection",
          "omnicopilot.installOmniRoute",
          "omnicopilot.openGitHub",
        ]);
        if (typeof msg.command !== "string" || !allowedCommands.has(msg.command)) break;
        await vscode.commands.executeCommand(msg.command);
        break;
      }
    }
  }

  private async buildStatus(): Promise<PanelStatus> {
    const routes = await cachedLoadRoutes(this.context);
    const routeStatuses = await Promise.all(
      routes.map(async (r) => {
        const client = getClientForRoute(r, this.log);
        const online = await client.ping(5000);
        return {
          id: r.id,
          name: r.name,
          url: client.baseUrl,
          hasKey: Boolean(r.apiKey),
          online,
          modelCount: null,
        };
      })
    );
    return {
      type: "status",
      routes: routeStatuses,
      onlineCount: routeStatuses.filter((s) => s.online).length,
      total: routeStatuses.length,

    };
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const t = vscode.l10n.t;
    const S = {
      title: t("OmniRoute for Copilot"),
      add: t("Add server"),
      remove: t("Remove this server"),
      serverName: t("Name"),
      serverUrl: t("Base URL"),
      urlPlaceholder: t("http://localhost:20128/v1"),
      apiKey: t("API key"),
      keyPlaceholder: t("paste key (optional)"),
      keyStored: t("A key is stored in the OS keychain. Empty to keep."),
      online: t("Online"),
      offline: t("Offline"),
      save: t("Save servers"),
      saved: t("Saved."),
      summary: t("{0}/{1} servers online"),
      linkRefresh: t("Refresh models in the picker"),
      linkDashboard: t("Open a dashboard"),
      linkCli: t("Configure a coding CLI (Codex, Claude Code…)"),
      linkInstall: t("Install OmniRoute"),
      linkGitHub: t("OmniRoute on GitHub"),
    };
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px 14px; font-size: 12px; }
  h3 { margin: 4px 0 10px; font-size: 13px; display: flex; align-items: center; gap: 7px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-charts-red); display: inline-block; }
  .dot.on { background: var(--vscode-charts-green); }
  .dot.off { background: var(--vscode-charts-red); }
  .card { border: 1px solid var(--vscode-input-border, #555); border-radius: 4px; padding: 8px; margin-bottom: 8px; }
  .row { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
  .row label { width: 64px; opacity: .8; flex: none; }
  input[type=text], input[type=password] { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 5px; }
  .status { display: flex; align-items: center; gap: 6px; min-height: 14px; opacity: .9; }
  .remove { background: none; border: none; color: var(--vscode-editorError-foreground); cursor: pointer; font-size: 13px; padding: 0 4px; }
  .remove:disabled { opacity: .35; cursor: default; }
  .hint { opacity: .7; font-style: italic; padding: 6px 0; }
  button.primary { width: 100%; padding: 6px; cursor: pointer; margin-top: 4px; }
  .links { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
  .link { cursor: pointer; opacity: .9; display: flex; align-items: center; gap: 6px; }
  .link:hover { text-decoration: underline; }
  .codicon { font-family: "codicon"; font-size: 14px; line-height: 1; }
</style>
</head>
<body>
<h3><span id="dot" class="dot"></span> ${S.title}</h3>
<div id="summary" style="opacity:.8; margin-bottom:8px"></div>
<div id="routes"></div>
<button id="add" class="primary">＋ ${S.add}</button>
<button id="save" class="primary">${S.save}</button>

<div class="links">
  <div class="link" data-cmd="omnicopilot.refreshModels"><span class="codicon codicon-sync"></span> ${S.linkRefresh}</div>
  <div class="link" data-cmd="omnicopilot.openDashboard"><span class="codicon codicon-dashboard"></span> ${S.linkDashboard}</div>
  <div class="link" data-cmd="omnicopilot.configureCliTool"><span class="codicon codicon-terminal"></span> ${S.linkCli}</div>
  <div class="link" data-cmd="omnicopilot.installOmniRoute"><span class="codicon codicon-cloud-download"></span> ${S.linkInstall}</div>
  <div class="link" data-cmd="omnicopilot.openGitHub"><span class="codicon codicon-github"></span> ${S.linkGitHub}</div>
</div>


<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const STRINGS = ${JSON.stringify(S)};
  function el(tag, props) { const n = document.createElement(tag); if (props) Object.assign(n, props); return n; }
  const host = document.getElementById("routes");
  const dot = document.getElementById("dot");
  const summaryEl = document.getElementById("summary");
  const addBtn = document.getElementById("add");
  const saveBtn = document.getElementById("save");
  let routes = []; // [{id, name, url, hasKey, online, modelCount}]

  function render() {
    host.textContent = "";
    if (routes.length === 0) host.appendChild(el("div", { className: "hint", textContent: "＋ " + STRINGS.add }));
    routes.forEach((r, i) => {
      const card = el("div", { className: "card" });
      const name = el("input", { type: "text", value: r.name || "", maxLength: 40 });
      const url = el("input", { type: "text", value: r.url || "", placeholder: STRINGS.urlPlaceholder, spellcheck: false });
      const key = el("input", { type: "password", value: "", placeholder: r.hasKey ? STRINGS.keyStored : STRINGS.keyPlaceholder, spellcheck: false });
      const stDot = el("span", { className: "dot" + (r.online ? " on" : " off") });
      const stText = el("span", { textContent: r.online ? STRINGS.online : STRINGS.offline });
      const rem = el("button", { className: "remove", title: STRINGS.remove, textContent: "✕" });
      rem.disabled = routes.length <= 1;
      rem.addEventListener("click", () => { routes.splice(i, 1); render(); });

      const row = (label, field) => {
        const rw = el("div", { className: "row" });
        rw.appendChild(el("label", { textContent: label }));
        rw.appendChild(field);
        return rw;
      };
      card.appendChild(row(STRINGS.serverName, name));
      card.appendChild(row(STRINGS.serverUrl, url));
      card.appendChild(row(STRINGS.apiKey, key));
      const st = el("div", { className: "status" });
      st.appendChild(stDot); st.appendChild(stText); st.appendChild(el("span", { style: "flex:1" }));
      card.appendChild(st); card.appendChild(rem);
      card.__idx = i;
      host.appendChild(card);
    });
  }

  addBtn.addEventListener("click", () => {
    routes.push({ id: "new-" + crypto.randomUUID(), name: "", url: "", hasKey: false, online: false, modelCount: null });
    render();
  });

  saveBtn.addEventListener("click", () => {
    const payload = [];
    Array.from(host.querySelectorAll(".card")).forEach((cardEl) => {
      const inputs = cardEl.querySelectorAll("input");
      const r = routes[cardEl.__idx];
      payload.push({ id: r?.id ?? "", name: inputs[0].value, url: inputs[1].value, apiKey: inputs[2].value });
    });
    vscodeApi.postMessage({ type: "save", routes: payload });
    saveBtn.textContent = STRINGS.saved;
    setTimeout(() => { saveBtn.textContent = STRINGS.save; }, 1200);
  });

  document.querySelectorAll(".link").forEach((lnk) =>
    lnk.addEventListener("click", () => vscodeApi.postMessage({ type: "action", command: lnk.dataset.cmd }))
  );

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type !== "status") return;
    dot.className = "dot" + (msg.onlineCount > 0 ? " on" : " off");
    summaryEl.textContent = msg.total === 1
      ? (msg.routes[0]?.online ? STRINGS.online : STRINGS.offline)
      : STRINGS.summary.replace("{0}", msg.onlineCount).replace("{1}", msg.total);
    routes = msg.routes.map((r) => ({ id: r.id, name: r.name, url: r.url, hasKey: r.hasKey, online: r.online, modelCount: r.modelCount }));
    render();
  });

  vscodeApi.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}
