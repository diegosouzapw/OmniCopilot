import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { formatErrorValue } from "./client";
import type { MetricsTracker } from "./metrics";
import { fmtTokens } from "./metrics";
import { cachedLoadRoutes, type Route } from "./routes";
import type { ConnectionStatusBar } from "./statusBar";
import type { StatusSnapshot } from "./status/statusRenderer";

export class OmniStatusPopup {
  private static currentPanel: vscode.WebviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private webviewReady = false;
  private isUpdating = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly metricsTracker: MetricsTracker,
    private readonly log: vscode.LogOutputChannel,
    private readonly statusBar: ConnectionStatusBar
  ) {
    this.panel = panel;
    this.log.info("OmniStatusPopup webview panel created.");

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Listen for real-time metrics changes from MetricsTracker. These fire on
    // every persist (debounced ~1s after any activity). Refreshing the full
    // state here would ping servers again → recordActivity → persist → ...,
    // a self-sustaining ~1s ping loop. So metrics changes only re-render the
    // cached state with fresh numbers; explicit pings stay on the 3s timer and
    // on manual "ready"/"refresh".
    this.disposables.push(
      this.metricsTracker.onDidChangeMetrics(() => {
        this.renderMetricsOnly();
      }),
      this.statusBar.onDidChangeSnapshot((snapshot) => {
        void this.renderStatusSnapshot(snapshot);
      })
    );

    this.panel.webview.onDidReceiveMessage(
      async (msg: { command: string; value?: unknown }) => {
        switch (msg.command) {
          case "ready":
            this.webviewReady = true;
            this.lastUpdateMs = 0;
            await this.updateStateData();
            break;
          case "refresh":
            this.lastUpdateMs = 0;
            await this.updateStateData();
            break;
          case "resetMetrics":
            await this.metricsTracker.resetMetrics();
            await this.updateStateData();
            void vscode.window.showInformationMessage(
              vscode.l10n.t("Token metrics reset.")
            );
            break;
          case "toggleSetting":
            await this.handleToggleSetting(msg.value);
            break;
          case "changeFallbackMode":
            await this.handleChangeFallbackMode(msg.value);
            break;
          case "runCommand":
            await this.handleRunCommand(msg.value);
            break;
          case "snooze":
            void vscode.window.showInformationMessage(
              vscode.l10n.t("Status bar metrics snoozed for 5 minutes.")
            );
            break;
        }
      },
      null,
      this.disposables
    );

    this.panel.webview.html = this.getHtmlForWebview();
  }

  public static show(
    context: vscode.ExtensionContext,
    metricsTracker: MetricsTracker,
    log: vscode.LogOutputChannel,
    statusBar: ConnectionStatusBar
  ): void {
    if (OmniStatusPopup.currentPanel) {
      OmniStatusPopup.currentPanel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "omniRouteStatusPopup",
      vscode.l10n.t("OmniRoute — Status & Metrics"),
      {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      }
    );

    OmniStatusPopup.currentPanel = panel;
    const popup = new OmniStatusPopup(panel, context, metricsTracker, log, statusBar);
    // Kick off the initial state fetch outside the constructor: async work
    // started in a constructor is fire-and-forget and its errors would be
    // unobservable there. Same timing, observable errors via updateStateData's
    // own try/catch logging.
    void popup.updateStateData();
  }

  public dispose(): void {
    OmniStatusPopup.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  /** Apply a user toggle for a quick-settings item (only allowed items). */
  private async handleToggleSetting(value: unknown): Promise<void> {
    const payload = value as { setting: string; enabled: boolean };
    // Only settings the popup is allowed to flip may be written.
    const allowedSettings = new Set(["statusBar"]);
    if (typeof payload?.setting !== "string" || !allowedSettings.has(payload.setting)) return;
    if (typeof payload.enabled !== "boolean") return;
    await vscode.workspace
      .getConfiguration("omnicopilot")
      .update(payload.setting, payload.enabled, vscode.ConfigurationTarget.Global);
    // Reflect the toggle immediately so a metrics-only render can't
    // flip it back before the throttled refresh runs.
    if (this.lastState) {
      this.lastState = { ...this.lastState, statusBarEnabled: payload.enabled };
      void this.panel.webview.postMessage({ command: "updateState", state: this.lastState });
    }
    this.lastUpdateMs = 0;
    await this.updateStateData();
  }

  /** Apply a user-chosen fallback strategy. */
  private async handleChangeFallbackMode(value: unknown): Promise<void> {
    const mode = value as string;
    const allowedModes = new Set(["sameModel", "sameFamily", "full", "none"]);
    if (typeof mode !== "string" || !allowedModes.has(mode)) return;
    await vscode.workspace
      .getConfiguration("omnicopilot")
      .update("fallbackMode", mode, vscode.ConfigurationTarget.Global);
    // Reflect the choice immediately (even if updateStateData is
    // throttled/in-flight) so a metrics-only render can't revert it.
    if (this.lastState) {
      this.lastState = { ...this.lastState, fallbackMode: mode };
      void this.panel.webview.postMessage({
        command: "updateState",
        state: { ...this.lastState, fallbackMode: mode },
      });
    }
    this.lastUpdateMs = 0;
    await this.updateStateData();
  }

  /** Run an allow-listed command coming from the webview. */
  private async handleRunCommand(value: unknown): Promise<void> {
    const payload = value as { cmd?: unknown; args?: unknown[] };
    const allowedCommands = new Set([
      "omnicopilot.openDashboard",
      "omnicopilot.manage",
      "omnicopilot.refreshModels",
      "omnicopilot.configureCliTool",
      "omnicopilot.checkConnection",
      "omnicopilot.installOmniRoute",
      "omnicopilot.openGitHub",
      "workbench.action.openSettings",
    ]);
    if (typeof payload.cmd !== "string" || !allowedCommands.has(payload.cmd)) return;
    if (payload.args && payload.args.length > 0) {
      await vscode.commands.executeCommand(payload.cmd, ...payload.args);
    } else {
      await vscode.commands.executeCommand(payload.cmd);
    }
  }

  private lastUpdateMs = 0;

  private lastState:
    | {
        metrics: Record<string, unknown>;
        servers: unknown[];
        suggestions: unknown[];
        fallbackMode: string;
        statusBarEnabled: boolean;
        retriesPerServer: number;
      }
    | undefined;

  private lastUsedRoutes: Route[] | undefined;

  /** Re-render the previously pinged state with fresh metrics numbers only.
   * Never pings servers, so it cannot re-trigger recordActivity/persist. */
  private renderMetricsOnly(): void {
    if (!this.panel.visible || !this.lastState) return;
    const routes = this.lastUsedRoutes;
    const metrics = this.metricsTracker.getMetrics(routes ?? []);
    const updatedServers = (
      (this.lastState.servers as Array<{
        id: string;
        name: string;
        baseUrl: string;
        online: boolean;
        latencyMs?: number;
        metric: {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          cachedTokens: number;
          reasoningTokens: number;
          inputTokenProvenance: { reported: number; estimated: number; unknown: number };
          outputTokenProvenance: { reported: number; estimated: number; unknown: number };
          requestCount: number;
          successCount: number;
          errorCount: number;
          lastUsedModel?: string;
        };
      }>) || []
    ).map((s) => ({
      ...s,
      metric: {
        ...s.metric,
        inputTokens: metrics.servers[s.id]?.inputTokens ?? s.metric.inputTokens,
        outputTokens: metrics.servers[s.id]?.outputTokens ?? s.metric.outputTokens,
        totalTokens: metrics.servers[s.id]?.totalTokens ?? s.metric.totalTokens,
        cachedTokens: metrics.servers[s.id]?.cachedTokens ?? s.metric.cachedTokens,
        reasoningTokens: metrics.servers[s.id]?.reasoningTokens ?? s.metric.reasoningTokens,
        inputTokenProvenance:
          metrics.servers[s.id]?.inputTokenProvenance ?? s.metric.inputTokenProvenance,
        outputTokenProvenance:
          metrics.servers[s.id]?.outputTokenProvenance ?? s.metric.outputTokenProvenance,
        requestCount: metrics.servers[s.id]?.requestCount ?? s.metric.requestCount,
        successCount: metrics.servers[s.id]?.successCount ?? s.metric.successCount,
        errorCount: metrics.servers[s.id]?.errorCount ?? s.metric.errorCount,
        lastUsedModel: metrics.servers[s.id]?.lastUsedModel ?? s.metric.lastUsedModel,
      },
    }));

    const newState = {
      ...this.lastState,
      servers: updatedServers,
      metrics: {
        totalInputTokens: metrics.totalInputTokens,
        totalOutputTokens: metrics.totalOutputTokens,
        totalTokens: metrics.totalTokens,
        totalCachedTokens: metrics.totalCachedTokens ?? 0,
        totalReasoningTokens: metrics.totalReasoningTokens ?? 0,
        inputTokenProvenance: metrics.inputTokenProvenance,
        outputTokenProvenance: metrics.outputTokenProvenance,
        totalRequests: metrics.totalRequests,
        formattedTotalTokens: fmtTokens(metrics.totalTokens),
        formattedInputTokens: fmtTokens(metrics.totalInputTokens),
        formattedOutputTokens: fmtTokens(metrics.totalOutputTokens),
      },
    };
    this.lastState = newState;
    void this.panel.webview.postMessage({
      command: "updateState",
      state: newState,
    });
  }

  private async renderStatusSnapshot(
    snapshot: StatusSnapshot,
    settings?: {
      suggestions?: unknown[];
      fallbackMode?: string;
      statusBarEnabled?: boolean;
      retriesPerServer?: number;
    }
  ): Promise<void> {
    if (!this.webviewReady) return;
    const routes = this.lastUsedRoutes ?? (await cachedLoadRoutes(this.context));
    const byId = new Map(routes.map((route) => [route.id, route]));
    const metrics = this.metricsTracker.getMetrics(routes);
    const servers = snapshot.servers.map((server) => ({
      id: server.routeId,
      name: server.name,
      baseUrl: byId.get(server.routeId)?.baseUrl ?? "",
      online: server.online,
      latencyMs: server.latencyMs,
      metric: {
        inputTokens: metrics.servers[server.routeId]?.inputTokens ?? 0,
        outputTokens: metrics.servers[server.routeId]?.outputTokens ?? 0,
        totalTokens: metrics.servers[server.routeId]?.totalTokens ?? server.tokens,
        cachedTokens: metrics.servers[server.routeId]?.cachedTokens ?? 0,
        reasoningTokens: metrics.servers[server.routeId]?.reasoningTokens ?? 0,
        inputTokenProvenance: metrics.servers[server.routeId]?.inputTokenProvenance ?? {
          reported: 0,
          estimated: 0,
          unknown: 0,
        },
        outputTokenProvenance: metrics.servers[server.routeId]?.outputTokenProvenance ?? {
          reported: 0,
          estimated: 0,
          unknown: 0,
        },
        requestCount: metrics.servers[server.routeId]?.requestCount ?? server.requests,
        successCount: metrics.servers[server.routeId]?.successCount ?? 0,
        errorCount: metrics.servers[server.routeId]?.errorCount ?? 0,
        lastUsedModel: metrics.servers[server.routeId]?.lastUsedModel,
      },
    }));
    const prev = this.lastState ?? {
      suggestions: [],
      fallbackMode: "sameModel",
      statusBarEnabled: true,
      retriesPerServer: 1,
    };
    const state = {
      ...prev,
      suggestions: settings?.suggestions ?? prev.suggestions,
      fallbackMode: settings?.fallbackMode ?? prev.fallbackMode,
      statusBarEnabled: settings?.statusBarEnabled ?? prev.statusBarEnabled,
      retriesPerServer: settings?.retriesPerServer ?? prev.retriesPerServer,
      metrics: {
        totalInputTokens: metrics.totalInputTokens,
        totalOutputTokens: metrics.totalOutputTokens,
        totalTokens: metrics.totalTokens,
        totalCachedTokens: metrics.totalCachedTokens ?? 0,
        totalReasoningTokens: metrics.totalReasoningTokens ?? 0,
        inputTokenProvenance: metrics.inputTokenProvenance,
        outputTokenProvenance: metrics.outputTokenProvenance,
        totalRequests: metrics.totalRequests,
        formattedTotalTokens: fmtTokens(metrics.totalTokens),
        formattedInputTokens: fmtTokens(metrics.totalInputTokens),
        formattedOutputTokens: fmtTokens(metrics.totalOutputTokens),
      },
      servers,
    };
    await this.panel.webview.postMessage({ command: "updateState", state });
    this.lastState = {
      metrics: state.metrics,
      servers: state.servers,
      suggestions: state.suggestions,
      fallbackMode: state.fallbackMode,
      statusBarEnabled: state.statusBarEnabled,
      retriesPerServer: state.retriesPerServer,
    };
    this.lastUsedRoutes = routes;
  }

  private async updateStateData(): Promise<void> {
    const now = Date.now();
    if (!this.panel.visible) return;
    if (this.isUpdating || now - this.lastUpdateMs < 1000) return;
    this.isUpdating = true;
    this.lastUpdateMs = now;
    try {
      const routes = await cachedLoadRoutes(this.context);
      const cfg = vscode.workspace.getConfiguration("omnicopilot");
      const fallbackMode = cfg.get<string>("fallbackMode", "sameModel");
      const statusBarEnabled = cfg.get<boolean>("statusBar", true);
      const retriesPerServer = cfg.get<number>("retriesPerServer", 1);
      const snapshot = this.statusBar.getSnapshot();
      const suggestions = this.metricsTracker.generateSuggestions(
        routes,
        new Set(snapshot.servers.filter((server) => server.online).map((server) => server.routeId))
      );
      // renderStatusSnapshot merges `settings` into the posted state, so the
      // webview always reflects the real configuration — not stale defaults.
      await this.renderStatusSnapshot(snapshot, {
        suggestions,
        fallbackMode,
        statusBarEnabled,
        retriesPerServer,
      });
      this.lastUsedRoutes = routes;
    } catch (err) {
      this.log.error(`Error updating status popup state: ${formatErrorValue(err)}`);
    } finally {
      this.isUpdating = false;
    }
  }

  private getHtmlForWebview(): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OmniRoute Status & Metrics</title>
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --card-bg: var(--vscode-editor-background, #252526);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --border: var(--vscode-panel-border, #3c3c3c);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
      --success: #3fb950;
      --warning: #d29922;
      --danger: #f85149;
    }
    body {
      font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
      font-size: 13px;
      color: var(--fg);
      background-color: var(--bg);
      margin: 0;
      padding: 16px;
      line-height: 1.5;
    }
    .popup-container {
      max-width: 650px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 16px;
    }
    .header-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 16px;
      font-weight: 600;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
      transition: background-color 0.3s ease;
    }
    .dot-online { background-color: var(--success); box-shadow: 0 0 6px var(--success); }
    .dot-partial { background-color: var(--warning); box-shadow: 0 0 6px var(--warning); }
    .dot-offline { background-color: var(--danger); }

    .badge {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 10px;
      font-weight: 500;
    }
    .badge-success { background: rgba(63, 185, 80, 0.15); color: var(--success); }
    .badge-danger { background: rgba(248, 81, 73, 0.15); color: var(--danger); }
    .badge-impact-high, .badge-impact-alta { background: rgba(248, 81, 73, 0.2); color: #ff7b72; }
    .badge-impact-medium, .badge-impact-media { background: rgba(210, 153, 34, 0.2); color: #e3b341; }
    .badge-impact-low, .badge-impact-baja { background: rgba(56, 139, 253, 0.2); color: #58a6ff; }

    .header-actions {
      display: flex;
      gap: 8px;
    }
    .btn {
      background-color: var(--accent);
      color: #ffffff;
      border: none;
      padding: 5px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:hover { background-color: var(--accent-hover); }
    .btn-secondary {
      background-color: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
    }
    .btn-secondary:hover {
      background-color: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    .btn-sm { padding: 3px 8px; font-size: 11px; }

    .section {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
      margin-bottom: 16px;
    }
    .section-title {
      font-weight: 600;
      font-size: 13px;
      margin-top: 0;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Metric progress bars */
    .metric-group {
      margin-bottom: 12px;
    }
    .metric-label-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-bottom: 4px;
    }
    .progress-bar-bg {
      height: 8px;
      background-color: var(--border);
      border-radius: 4px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #0e639c, #3fb950);
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    /* Server cards list */
    .server-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .server-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 10px 12px;
    }
    .server-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .server-title {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .server-url {
      font-size: 11px;
      opacity: 0.7;
    }
    .server-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      font-size: 12px;
    }
    .stat-item {
      display: flex;
      flex-direction: column;
    }
    .stat-label { font-size: 10px; opacity: 0.65; }
    .stat-value { font-weight: 600; }
    .stat-value.highlight { color: #58a6ff; }
    .server-footer {
      font-size: 11px;
      opacity: 0.8;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px dashed var(--border);
    }

    /* Toggle items */
    .toggle-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .toggle-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .toggle-label {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    select {
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #ffffff);
      border: 1px solid var(--border);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
    }

    /* Suggestions */
    .suggestions-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .suggestion-card {
      border: 1px solid var(--border);
      border-left: 4px solid var(--accent);
      border-radius: 4px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.02);
    }
    .suggestion-optimization { border-left-color: #58a6ff; }
    .suggestion-redundancy { border-left-color: #d29922; }
    .suggestion-health { border-left-color: #f85149; }
    .suggestion-capability { border-left-color: #a371f7; }
    .suggestion-info { border-left-color: #3fb950; }

    .suggestion-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .suggestion-icon { font-size: 14px; }
    .suggestion-body {
      font-size: 12px;
      opacity: 0.85;
      margin-bottom: 8px;
    }

    .footer-links {
      display: flex;
      justify-content: space-between;
      margin-top: 16px;
      font-size: 12px;
    }
    .footer-links a {
      color: #58a6ff;
      text-decoration: none;
      cursor: pointer;
    }
    .footer-links a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="popup-container">
    <!-- Header -->
    <div class="header">
      <div class="header-title">
        <span id="header-dot" class="dot dot-offline"></span>
        <span>OmniRoute</span>
        <span id="header-badge" class="badge badge-danger">Loading...</span>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" data-action="runCommand" data-cmd="omnicopilot.openDashboard">📊 Dashboard</button>
        <button class="btn btn-secondary btn-sm" data-action="runCommand" data-cmd="omnicopilot.manage">⚙ Configure</button>
        <button class="btn btn-secondary btn-sm" data-action="sendMessage" data-msg="refresh">🔄 Refresh</button>
      </div>
    </div>

    <!-- Token Metrics Section -->
    <div class="section">
      <div class="section-title">
        <span>Token Consumption & Server Metrics</span>
        <button class="btn btn-secondary btn-sm" data-action="sendMessage" data-msg="resetMetrics">Reset Metrics</button>
      </div>

      <div class="metric-group">
        <div class="metric-label-row">
          <span>Total Tokens Consumed (Session)</span>
          <strong id="total-tokens-text">0 tokens (0 reqs)</strong>
        </div>
        <div class="progress-bar-bg">
          <div id="total-tokens-bar" class="progress-bar-fill" style="width: 0%"></div>
        </div>
      </div>

      <div class="metric-group">
        <div class="metric-label-row">
          <span>Input vs Output (traffic mix)</span>
          <strong id="io-ratio-text">In 0% · Out 0%</strong>
        </div>
        <div class="progress-bar-bg" style="height:14px; display:flex;">
          <div id="input-share-bar" class="progress-bar-fill" style="width:50%; background: linear-gradient(90deg, #3fb950, #58a6ff); border-radius:0;"></div>
          <div id="output-share-bar" class="progress-bar-fill" style="width:50%; background: linear-gradient(90deg, #a371f7, #58a6ff); border-radius:0;"></div>
        </div>
        <div class="metric-label-row" style="margin-top:6px;">
          <span id="input-tokens-text" style="color:#58a6ff;">Input: 0 tokens</span>
          <span id="output-tokens-text" style="color:#a371f7;">Output: 0 tokens</span>
        </div>
        <div class="metric-label-row" style="margin-top:4px;">
          <span id="io-avg-text" style="opacity:0.75; font-size:11px;">No requests yet</span>
        </div>
        <div id="subset-tokens-row" class="metric-label-row" style="margin-top:6px; display:none;">
          <span id="cached-tokens-text"></span>
          <span id="reasoning-tokens-text"></span>
        </div>
        <div class="metric-label-row" style="margin-top:4px; font-size:11px; opacity:0.75;">
          <span id="input-provenance-text">Input Provenance: reported 0 · estimated 0 · unknown 0</span>
        </div>
        <div class="metric-label-row" style="margin-top:2px; font-size:11px; opacity:0.75;">
          <span id="output-provenance-text">Output Provenance: reported 0 · estimated 0 · unknown 0</span>
        </div>
      </div>

      <div style="margin-top: 14px;">
        <div style="font-weight: 500; margin-bottom: 8px;">Connected Servers (<span id="server-count">0</span>)</div>
        <div id="server-list" class="server-list">
          <div style="opacity:0.6; font-style:italic">Loading servers...</div>
        </div>
      </div>
    </div>

    <!-- Quick Settings & Options -->
    <div class="section">
      <div class="section-title">
        <span>OmniRoute Quick Settings</span>
        <button class="btn btn-secondary btn-sm" data-action="sendMessage" data-msg="snooze">Snooze (5m)</button>
      </div>

      <div class="toggle-list">
        <div class="toggle-item">
          <label class="toggle-label">
            <input type="checkbox" id="status-bar-toggle" data-action="toggleSetting" data-setting="statusBar">
            <span>Show token consumption in status bar</span>
          </label>
        </div>

        <div class="toggle-item">
          <span>Fallback Strategy:</span>
          <select id="fallback-select" data-action="changeFallbackMode">
            <option value="sameModel">Same Model (Recommended)</option>
            <option value="sameFamily">Same Model Family</option>
            <option value="full">Full Fallback</option>
            <option value="none">Disabled (No Fallback)</option>
          </select>
        </div>

        <div class="toggle-item">
          <span>Retries per server:</span>
          <span id="retries-text" style="opacity:0.8; font-weight:500;">1 retry(ies) per server</span>
        </div>

        <div class="toggle-item">
          <span>Model Catalog Sync:</span>
          <button class="btn btn-secondary btn-sm" data-action="runCommand" data-cmd="omnicopilot.refreshModels">🔄 Sync Models</button>
        </div>
      </div>
    </div>

    <!-- Smart Suggestions & Improvement Recommendations -->
    <div class="section">
      <div class="section-title">
        <span>Improvement & Optimization Suggestions</span>
        <span id="suggestions-count" style="font-size:11px; opacity:0.6">0 recommendations</span>
      </div>
      <div id="suggestions-list" class="suggestions-list">
      </div>
    </div>

    <!-- Footer Links -->
    <div class="footer-links">
      <a href="#" data-action="runCommand" data-cmd="omnicopilot.configureCliTool">⚡ Configure CLI Bridge (Aider/Claude)</a>
      <a href="#" data-action="runCommand" data-cmd="omnicopilot.checkConnection">🩺 Check Server Health</a>
      <a href="#" data-action="runCommand" data-cmd="omnicopilot.openGitHub">⭐ OmniRoute on GitHub</a>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Delegated handlers — no inline event attributes (CSP: script-src 'nonce-…')
    document.addEventListener('click', (event) => {
      const el = (event.target instanceof Element) ? event.target.closest('[data-action]') : null;
      if (!el || !(el instanceof HTMLElement)) return;
      event.preventDefault();
      const action = el.dataset.action;
      if (action === 'runCommand') runCommand(el.dataset.cmd);
      else if (action === 'sendMessage') sendMessage(el.dataset.msg);
    }, true);
    document.addEventListener('change', (event) => {
      const el = (event.target instanceof Element) ? event.target.closest('[data-action]') : null;
      if (!el || !(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement)) return;
      const action = el.dataset.action;
       if (action === 'toggleSetting') toggleSetting(el.dataset.setting, el.checked);
       else if (action === 'changeFallbackMode') changeFallbackMode(el.value);
    }, true);

    function sendMessage(command, value) {
      vscode.postMessage({ command, value });
    }

    function runCommand(cmd, args) {
      vscode.postMessage({ command: 'runCommand', value: { cmd, args } });
    }

    function toggleSetting(setting, enabled) {
      vscode.postMessage({ command: 'toggleSetting', value: { setting, enabled } });
    }

    function changeFallbackMode(mode) {
      vscode.postMessage({ command: 'changeFallbackMode', value: mode });
    }

    function getSuggestionIcon(type) {
      switch (type) {
        case "optimization": return "💡";
        case "redundancy": return "🛡️";
        case "health": return "🚨";
        case "capability": return "⚡";
        default: return "ℹ️";
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function fmtTokens(n) {
      if (!n || n <= 0) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (!msg || msg.command !== 'updateState' || !msg.state) return;
      const state = msg.state;

      // Update Header Status
      const servers = state.servers || [];
      const onlineCount = servers.filter(s => s.online).length;
      const totalCount = servers.length;
      const isFullyOnline = totalCount > 0 && onlineCount === totalCount;
      const dotEl = document.getElementById('header-dot');
      const badgeEl = document.getElementById('header-badge');
      if (dotEl) {
        dotEl.className = 'dot ' + (isFullyOnline ? 'dot-online' : onlineCount > 0 ? 'dot-partial' : 'dot-offline');
      }
      if (badgeEl) {
        badgeEl.className = 'badge ' + (isFullyOnline ? 'badge-success' : 'badge-danger');
        badgeEl.textContent = totalCount === 0 ? 'No servers' : (onlineCount + '/' + totalCount + ' connected');
      }

      // Update Token Progress Bars
      const metrics = state.metrics || {};
      const totalTokensText = document.getElementById('total-tokens-text');
      const totalTokensBar = document.getElementById('total-tokens-bar');
      const inputTokensText = document.getElementById('input-tokens-text');
      const outputTokensText = document.getElementById('output-tokens-text');
      const ioRatioText = document.getElementById('io-ratio-text');
      const inputShareBar = document.getElementById('input-share-bar');
      const outputShareBar = document.getElementById('output-share-bar');
      const ioAvgText = document.getElementById('io-avg-text');
      const cachedTokensText = document.getElementById('cached-tokens-text');
      const reasoningTokensText = document.getElementById('reasoning-tokens-text');
      const subsetTokensRow = document.getElementById('subset-tokens-row');
      const inputProvenanceText = document.getElementById('input-provenance-text');
      const outputProvenanceText = document.getElementById('output-provenance-text');

      const maxReferenceTokens = 500000;
      const totalPct = Math.min(Math.round(((metrics.totalTokens || 0) / maxReferenceTokens) * 100), 100);
      // Traffic mix as a single composition: input and output shares of total
      // (both use the same chars/4 estimate, so the ratio is a fair readout).
      const inVal = metrics.totalInputTokens || 0;
      const outVal = metrics.totalOutputTokens || 0;
      const inShare = inVal + outVal > 0 ? Math.min(100, Math.round((inVal / (inVal + outVal)) * 100)) : 50;
      const outShare = 100 - inShare;
      const reqs = metrics.totalRequests || 0;

      if (totalTokensText) {
        totalTokensText.textContent = (metrics.formattedTotalTokens || '0') + ' tokens (' + reqs + ' reqs)';
      }
      if (totalTokensBar) {
        totalTokensBar.style.width = totalPct + '%';
      }
      if (inputTokensText) {
        inputTokensText.textContent = (metrics.formattedInputTokens || fmtTokens(inVal)) + ' tokens (' + inShare + '%)';
      }
      if (outputTokensText) {
        outputTokensText.textContent = (metrics.formattedOutputTokens || fmtTokens(outVal)) + ' tokens (' + outShare + '%)';
      }
      if (ioRatioText) {
        ioRatioText.textContent = 'In ' + inShare + '% · Out ' + outShare + '%';
      }
      if (inputShareBar) inputShareBar.style.width = inShare + '%';
      if (outputShareBar) outputShareBar.style.width = outShare + '%';
      if (ioAvgText) {
        ioAvgText.textContent = reqs > 0
          ? 'avg per request: In ' + fmtTokens(Math.round(inVal / reqs)) + ' · Out ' + fmtTokens(Math.round(outVal / reqs))
          : 'No requests yet';
      }
      if (cachedTokensText) {
        cachedTokensText.textContent = metrics.totalCachedTokens
          ? 'Cached Input: ' + fmtTokens(metrics.totalCachedTokens)
          : '';
      }
      if (reasoningTokensText) {
        reasoningTokensText.textContent = metrics.totalReasoningTokens
          ? 'Reasoning Output: ' + fmtTokens(metrics.totalReasoningTokens)
          : '';
      }
      if (subsetTokensRow) {
        subsetTokensRow.style.display = metrics.totalCachedTokens || metrics.totalReasoningTokens
          ? 'flex'
          : 'none';
      }
      const provenanceText = p => 'reported ' + fmtTokens(p?.reported || 0) + ' · estimated ' + fmtTokens(p?.estimated || 0) + ' · unknown ' + fmtTokens(p?.unknown || 0);
      if (inputProvenanceText) inputProvenanceText.textContent = 'Input Provenance: ' + provenanceText(metrics.inputTokenProvenance);
      if (outputProvenanceText) outputProvenanceText.textContent = 'Output Provenance: ' + provenanceText(metrics.outputTokenProvenance);

      // Update Server List
      const serverCountEl = document.getElementById('server-count');
      const serverListEl = document.getElementById('server-list');
      if (serverCountEl) serverCountEl.textContent = String(totalCount);
      if (serverListEl) {
        if (servers.length === 0) {
          serverListEl.innerHTML = '<div style="opacity:0.6; font-style:italic">No servers configured.</div>';
        } else {
          const totalSessionTokens = state.metrics?.totalTokens || 0;
          serverListEl.innerHTML = servers.map(s => {
            const serverTokens = s.metric?.totalTokens || 0;
            const serverSharePct = totalSessionTokens > 0
              ? Math.min(100, Math.round((serverTokens / totalSessionTokens) * 100))
              : 0;
            const reqCount = s.metric?.requestCount || 0;
            const succCount = s.metric?.successCount || 0;
            const successRate = reqCount > 0 ? Math.round((succCount / reqCount) * 100) : 100;
            return \`
              <div class="server-card">
                <div class="server-header">
                  <div class="server-title">
                    <span class="dot \${s.online ? "dot-online" : "dot-offline"}"></span>
                    <strong>\${escapeHtml(s.name)}</strong>
                    <span class="badge \${s.online ? "badge-success" : "badge-danger"}">
                      \${s.online ? (s.latencyMs === undefined ? "Online" : s.latencyMs + "ms") : "Offline"}
                    </span>
                    \${serverSharePct > 0 ? \`<span class="badge" style="background:rgba(88,166,255,0.15);color:#58a6ff;">\${serverSharePct}% share</span>\` : ""}
                  </div>
                  <span class="server-url">\${escapeHtml(s.baseUrl)}</span>
                </div>
                <div class="server-stats">
                  <div class="stat-item">
                    <span class="stat-label">Input Tokens</span>
                    <span class="stat-value">\${fmtTokens(s.metric.inputTokens)}</span>
                  </div>
                  <div class="stat-item">
                    <span class="stat-label">Output Tokens</span>
                    <span class="stat-value">\${fmtTokens(s.metric.outputTokens)}</span>
                  </div>
                  <div class="stat-item">
                    <span class="stat-label">Total Tokens</span>
                    <span class="stat-value highlight">\${fmtTokens(s.metric.totalTokens)}</span>
                  </div>
                  <div class="stat-item">
                    <span class="stat-label">Requests / Success</span>
                    <span class="stat-value">\${reqCount} <span style="font-size:10px;opacity:0.75;">(\${successRate}%)</span></span>
                  </div>
                </div>
                \${serverTokens > 0 ? \`
                <div class="progress-bar-bg" style="height:4px; margin-top:8px;">
                  <div class="progress-bar-fill" style="width:\${serverSharePct}%;"></div>
                </div>\` : ""}
                \${s.metric.lastUsedModel ? \`<div class="server-footer" style="margin-top:6px;">Last model: <code>\${escapeHtml(s.metric.lastUsedModel)}</code></div>\` : ""}
              </div>
            \`;
          }).join("");
        }
      }

      // Update Settings & Toggles
      const toggleEl = document.getElementById('status-bar-toggle');
      const fallbackEl = document.getElementById('fallback-select');
      const retriesEl = document.getElementById('retries-text');
      if (toggleEl && typeof state.statusBarEnabled === 'boolean') {
        toggleEl.checked = state.statusBarEnabled;
      }
      if (fallbackEl && state.fallbackMode) {
        fallbackEl.value = state.fallbackMode;
      }
      if (retriesEl && typeof state.retriesPerServer === 'number') {
        retriesEl.textContent = state.retriesPerServer + ' retry(ies) per server';
      }

      // Update Suggestions
      const suggestions = state.suggestions || [];
      const suggCountEl = document.getElementById('suggestions-count');
      const suggListEl = document.getElementById('suggestions-list');
      if (suggCountEl) suggCountEl.textContent = suggestions.length + ' recommendations';
      if (suggListEl) {
        suggListEl.innerHTML = suggestions.map(s => \`
          <div class="suggestion-card suggestion-\${escapeHtml(s.type)}">
            <div class="suggestion-header">
              <span class="suggestion-icon">\${getSuggestionIcon(s.type)}</span>
              <strong>\${escapeHtml(s.title)}</strong>
              <span class="badge badge-impact-\${escapeHtml((s.impact || '').toLowerCase())}">Impact: \${escapeHtml(s.impact)}</span>
            </div>
            <div class="suggestion-body">\${escapeHtml(s.description)}</div>
            \${s.actionLabel ? \`<button class="btn btn-secondary btn-sm suggestion-action" data-command="\${escapeHtml(s.actionCommand || '')}" data-args="\${escapeHtml(JSON.stringify(s.actionArgs || []))}">\${escapeHtml(s.actionLabel)} →</button>\` : ""}
          </div>
        \`).join("");
        suggListEl.querySelectorAll('.suggestion-action').forEach(button => {
          button.addEventListener('click', () => {
            const command = button.getAttribute('data-command');
            if (!command) return;
            let args = [];
            try { args = JSON.parse(button.getAttribute('data-args') || '[]'); } catch { return; }
            runCommand(command, args);
          });
        });
      }
    });

    // Request initial data on ready
    sendMessage('ready');
  </script>
</body>
</html>`;
  }
}
