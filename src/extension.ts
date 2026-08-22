import * as vscode from "vscode";
import { formatErrorValue, serverRootUrl } from "./client";
import { configureCliTool } from "./cliBridge";
import { OmniPanelProvider } from "./panel";
import { OmniRouteChatProvider } from "./provider";
import { SECRET_PREFIX, cachedLoadRoutes, invalidateRouteCache, getClientForRoute } from "./routes";
import { ConnectionStatusBar } from "./statusBar";
import { MetricsTracker } from "./metrics";
import type { ResolvedChatUsage } from "./usage";
import { OmniStatusPopup } from "./statusPopup";
import { registerFixedTools } from "./tools";

const OMNIROUTE_REPO = "https://github.com/diegosouzapw/OmniRoute";
const VENDOR = "omniroute";

let activeProviders: OmniRouteChatProvider[] = [];
let providerDisposables: vscode.Disposable[] = [];
let statusBar: ConnectionStatusBar | undefined;
let panel: OmniPanelProvider | undefined;
let metricsTracker: MetricsTracker | undefined;
let syncPromise: Promise<void> = Promise.resolve();

function getConfig() {
  return vscode.workspace.getConfiguration("omnicopilot");
}

async function refreshAll(): Promise<void> {
  for (const p of activeProviders) {
    await p.refresh();
  }
}

function syncProviders(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  syncPromise = syncPromise.then(() => doSyncProviders(context, log)).catch((err) => {
    log.error(`Failed to sync providers: ${formatErrorValue(err)}`);
  });
  return syncPromise;
}

async function doSyncProviders(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  for (const d of providerDisposables) {
    d.dispose();
  }
  providerDisposables = [];
  activeProviders = [];

  const routes = await cachedLoadRoutes(context);
  const activeRoutes = routes.slice(0, 10);
  await vscode.commands.executeCommand("setContext", "omnicopilot.routeCount", activeRoutes.length);
  const droppedRoutes = routes.slice(10);
  if (droppedRoutes.length > 0) {
    const names = droppedRoutes.map((r) => r.name.trim() || r.id).join(", ");
    log.warn(
      `OmniRoute supports up to 10 active servers simultaneously. Truncating ${routes.length} configured servers to 10. Not imported: ${names}.`
    );
  }

  const deps = {
    context,
    log,
    onActivity: (ok: boolean, routeId?: string) => statusBar?.reportActivity(ok, routeId),
    onUsage: (usage: ResolvedChatUsage) => statusBar?.reportUsage(usage),
    onRequestStart: (routeId: string | undefined, modelName: string) =>
      statusBar?.reportRequestStart(routeId, modelName),
    onRequestEnd: (ok: boolean, error: string | undefined, fallbacksUsed: number) =>
      statusBar?.reportRequestEnd(ok, error, fallbacksUsed),
    getOnlineRouteIds: () => statusBar?.onlineRouteIds(),
    onStall: (routeId: string) => {
      const route = activeRoutes.find((r) => r.id === routeId);
      if (route && metricsTracker) {
        void metricsTracker.recordStall(routeId, route.name, route.baseUrl);
      }
    },
  };

  if (activeRoutes.length <= 1) {
    const p = new OmniRouteChatProvider(deps);
    try {
      const reg = vscode.lm.registerLanguageModelChatProvider(VENDOR, p as unknown as vscode.LanguageModelChatProvider);
      activeProviders.push(p);
      providerDisposables.push(p, reg);
      log.info(`Registered provider for vendor "${VENDOR}" (${activeRoutes.length} server(s) configured)`);
    } catch (err) {
      log.error(`Failed to register chat provider for vendor "${VENDOR}": ${formatErrorValue(err)}`);
    }
  } else {
    activeRoutes.forEach((route, index) => {
      const vendorId = index === 0 ? VENDOR : `omniroute-${index + 1}`;
      const p = new OmniRouteChatProvider(deps, route.id);
      try {
        const reg = vscode.lm.registerLanguageModelChatProvider(vendorId, p as unknown as vscode.LanguageModelChatProvider);
        activeProviders.push(p);
        providerDisposables.push(p, reg);
        log.info(`Registered provider for server "${route.name}" under vendor slot "${vendorId}" (routeId: ${route.id})`);
      } catch (err) {
        log.error(`Failed to register chat provider for vendor "${vendorId}" (server: ${route.name}): ${formatErrorValue(err)}`);
      }
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("OmniRoute for Copilot", { log: true });
  context.subscriptions.push(log);
  log.info(`Activating v${context.extension.packageJSON.version}`);

  OmniRouteChatProvider.loadPersistentCache(context);

  metricsTracker = new MetricsTracker(context);

  registerFixedTools(context, log);

  statusBar = new ConnectionStatusBar(
    async () => {
      return cachedLoadRoutes(context);
    },
    log,
    metricsTracker
  );
  context.subscriptions.push(statusBar);

  void syncProviders(context, log);

  panel = new OmniPanelProvider(context, log, async () => {
    statusBar?.restart();
    await syncProviders(context, log);
    await refreshAll();
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OmniPanelProvider.viewId, panel)
  );

  registerCommands(context, log, refreshAll);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("omnicopilot")) return;
      log.info("Configuration changed — refreshing models and status");
      invalidateRouteCache();
      statusBar?.restart();
      void syncProviders(context, log).then(() => refreshAll());
      void panel?.refreshStatus();
    })
  );

  statusBar.start();
  void checkFirstRun(context, log);
}

/** Explain once why `dashboardOpen: "editor"` fell back to the browser. The flag
 * is compiled into the OmniRoute build, so this cannot be fixed from the client. */
let embedWarningShown = false;
async function warnDashboardNotEmbeddable(): Promise<void> {
  if (embedWarningShown) return;
  embedWarningShown = true;
  const learnMore = vscode.l10n.t("How to enable it");
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "This OmniRoute server does not allow embedding, so the dashboard opened in your browser. It has to be built with DASHBOARD_ALLOW_EMBED=vscode — a build-time option, so setting the variable on an existing install is not enough."
    ),
    learnMore
  );
  if (pick === learnMore) {
    void vscode.env.openExternal(
      vscode.Uri.parse("https://github.com/diegosouzapw/OmniRoute/blob/main/docs/guides/VSCODE-COPILOT.md")
    );
  }
}

function registerCommands(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  onRefresh: () => Promise<void>
): void {
  const register = (id: string, fn: (...args: readonly unknown[]) => void | Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // The management gear in "Manage Models" and the status-bar menu both land
  // on the visual panel (Activity Bar view) where URL + API key live.
  register("omnicopilot.manage", () => panel?.focus());
  register("omnicopilot.setApiKey", () => setApiKey(context, log));

  register("omnicopilot.refreshModels", async () => {
    await onRefresh();
    const routes = await cachedLoadRoutes(context);
    if (activeProviders.length > 0) {
      const cts = new vscode.CancellationTokenSource();
      // Re-list every server: in multi-vendor mode each provider is scoped to
      // one route, so counting only providers[0] would under-report model(s).
      const models = (
        await Promise.all(
          activeProviders.map((p) => p.provideLanguageModelChatInformation({ silent: true }, cts.token))
        )
      ).flat();
      await cts.dispose();
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Models synced: {0} model(s) found across {1} server(s).", models.length, routes.length)
      );
    } else {
      void vscode.window.showInformationMessage(vscode.l10n.t("Model list updated."));
    }
  });

  register("omnicopilot.checkConnection", async () => {
    const ok = await statusBar?.checkNow();
    if (ok) {
      const routes = await cachedLoadRoutes(context);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Connected to OmniRoute at {0}.", routes[0]?.baseUrl ?? "")
      );
    } else {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "OmniRoute is unreachable. Check that it is running (npx omniroute) and that omnicopilot.routes is configured."
        )
      );
    }
  });

  register("omnicopilot.openDashboard", async () => {
    const routes = await cachedLoadRoutes(context);
    if (routes.length === 0) return;
    let targetRoute = routes[0];
    if (routes.length > 1) {
      const picked = await vscode.window.showQuickPick(
        routes.map((r) => ({
          label: r.name,
          description: serverRootUrl(r.baseUrl),
          route: r,
        })),
        { title: vscode.l10n.t("OmniRoute: open dashboard") }
      );
      if (!picked) return;
      targetRoute = picked.route;
    }
    const root = serverRootUrl(targetRoute.baseUrl);
    const mode = getConfig().get<string>("dashboardOpen", "external");
    if (mode === "editor") {
      // The Simple Browser is an iframe, so the server must allow framing.
      // Probing first matters: simpleBrowser.show SUCCEEDS against a server that
      // sends X-Frame-Options: DENY, leaving a "refused to connect" tab that the
      // catch below would never see.
      const client = getClientForRoute(targetRoute, log);
      if (await client.canEmbedDashboard()) {
        try {
          await vscode.commands.executeCommand("simpleBrowser.show", root);
          return;
        } catch (err) {
          log.warn(`Simple Browser unavailable, falling back to external: ${formatErrorValue(err)}`);
        }
      } else {
        log.info(
          `${root} does not allow framing — opening externally. Rebuild OmniRoute with DASHBOARD_ALLOW_EMBED=vscode to enable the editor tab.`
        );
        void warnDashboardNotEmbeddable();
      }
    }
    void vscode.env.openExternal(vscode.Uri.parse(root));
  });

  register("omnicopilot.openGitHub", () => {
    void vscode.env.openExternal(vscode.Uri.parse(OMNIROUTE_REPO));
  });

  register("omnicopilot.installOmniRoute", async () => {
    const copyLabel = vscode.l10n.t("Copy install command");
    const githubLabel = vscode.l10n.t("Open GitHub");
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "OmniRoute is a free, open-source AI router: one endpoint, 340+ providers (90+ free), auto-fallback. Install it with npm and this extension lights up automatically."
      ),
      copyLabel,
      githubLabel
    );
    if (pick === copyLabel) {
      await vscode.env.clipboard.writeText("npm install -g omniroute && omniroute");
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Copied "{0}" — paste it in any terminal.', "npm install -g omniroute && omniroute")
      );
    } else if (pick === githubLabel) {
      void vscode.env.openExternal(vscode.Uri.parse(OMNIROUTE_REPO));
    }
  });

  register("omnicopilot.configureCliTool", (toolId?: unknown) =>
    configureCliTool(context, log, typeof toolId === "string" ? toolId : undefined)
  );

  register("omnicopilot.showStatusPopup", () => {
    if (metricsTracker && statusBar) {
      OmniStatusPopup.show(context, metricsTracker, log, statusBar);
    }
  });

  register("omnicopilot.quickActions", () => {
    if (metricsTracker && statusBar) {
      OmniStatusPopup.show(context, metricsTracker, log, statusBar);
    } else {
      void quickActions(context, log);
    }
  });
}


/** Explain once why `dashboardOpen: "editor"` fell back to the browser. The flag
 * is compiled into the OmniRoute build, so this cannot be fixed from the client. */
/** Menu behind the status-bar item. */
async function quickActions(context: vscode.ExtensionContext, log?: vscode.LogOutputChannel): Promise<void> {
  const routes = await cachedLoadRoutes(context);
  const results = await Promise.all(routes.map((r) => getClientForRoute(r, log).ping(4000)));
  const onlineCount = results.filter(Boolean).length;
  const online = onlineCount > 0;

  const items: Array<vscode.QuickPickItem & { action: string }> = [
    {
      label: online
        ? `$(circle-filled) ${vscode.l10n.t("Online")}`
        : `$(circle-outline) ${vscode.l10n.t("Offline")}`,
      description:
        routes.length === 1
          ? routes[0].baseUrl
          : `${vscode.l10n.t("{0}/{1} online", String(onlineCount), String(routes.length))}`,
      action: "check",
    },
    { label: `$(gear) ${vscode.l10n.t("Configure connection (URL / API key)")}`, action: "manage" },
    { label: `$(sync) ${vscode.l10n.t("Refresh models")}`, action: "refresh" },
    { label: `$(dashboard) ${vscode.l10n.t("Open OmniRoute dashboard")}`, action: "dashboard" },
    {
      label: `$(terminal) ${vscode.l10n.t("Configure a coding CLI (Codex, Claude Code…)")}`,
      action: "cli",
    },
    { label: `$(github) ${vscode.l10n.t("OmniRoute on GitHub")}`, action: "github" },
  ];
  if (!online) {
    items.splice(1, 0, {
      label: `$(cloud-download) ${vscode.l10n.t("Install OmniRoute")}`,
      description: "npm i -g omniroute",
      action: "install",
    });
  }

  const picked = await vscode.window.showQuickPick(items, { title: "OmniRoute" });
  const commandByAction: Record<string, string> = {
    check: "omnicopilot.checkConnection",
    manage: "omnicopilot.manage",
    refresh: "omnicopilot.refreshModels",
    dashboard: "omnicopilot.openDashboard",
    cli: "omnicopilot.configureCliTool",
    github: "omnicopilot.openGitHub",
    install: "omnicopilot.installOmniRoute",
  };
  if (picked) void vscode.commands.executeCommand(commandByAction[picked.action]);
}

async function setApiKey(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  optionalFlow = false
): Promise<void> {
  const routes = await cachedLoadRoutes(context);
  if (routes.length === 0) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("Add a route in the OmniRoute panel first, then set its API key.")
    );
    return;
  }
  let route = routes[0];
  if (routes.length > 1) {
    const picked = await vscode.window.showQuickPick(
      routes.map((r) => ({ label: r.name, description: r.baseUrl, route: r })),
      { title: vscode.l10n.t("OmniRoute: pick a server") }
    );
    if (!picked) return;
    route = picked.route;
  }

  const existing = await context.secrets.get(SECRET_PREFIX + route.id);
  const key = await vscode.window.showInputBox({
    title: vscode.l10n.t("OmniRoute API key — {0}", route.name),
    prompt: optionalFlow
      ? vscode.l10n.t(
          "Optional — leave empty if this server does not require an API key. Stored in the OS keychain."
        )
      : vscode.l10n.t("Stored securely in the OS keychain (SecretStorage). Leave empty to clear."),
    value: existing ?? "",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;

  if (key.trim()) {
    await context.secrets.store(SECRET_PREFIX + route.id, key.trim());
    log.info(`API key stored in SecretStorage (${route.id})`);
  } else if (existing) {
    await context.secrets.delete(SECRET_PREFIX + route.id);
    log.info(`API key cleared (${route.id})`);
  }
  if (!optionalFlow) await refreshAll();
}

/** One-time welcome: point users at the model picker or at installing OmniRoute. */
async function checkFirstRun(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  const FLAG = "omnicopilot.welcomed";
  if (context.globalState.get<boolean>(FLAG)) return;
  await context.globalState.update(FLAG, true);

  const routes = await cachedLoadRoutes(context);
  const results = await Promise.all(routes.map((r) => getClientForRoute(r).ping()));
  const online = results.some(Boolean);
  log.info(`First run — OmniRoute ${online ? "detected" : "not detected"} (${routes.length} route(s))`);

  if (online) {
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "OmniRoute detected! Your models are ready — open the Copilot Chat model picker and choose any OmniRoute model."
      ),
      vscode.l10n.t("How to pick a model")
    );
    if (pick) {
      void vscode.env.openExternal(
        vscode.Uri.parse("https://code.visualstudio.com/docs/agent-customization/language-models")
      );
    }
  } else {
    const installLabel = vscode.l10n.t("Install OmniRoute");
    const configureLabel = vscode.l10n.t("Configure connection");
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "OmniCopilot: bring 1200+ AI models to Copilot Chat with OmniRoute — 90+ free providers, free forever. No OmniRoute server detected yet."
      ),
      installLabel,
      configureLabel
    );
    if (pick === installLabel) {
      void vscode.commands.executeCommand("omnicopilot.installOmniRoute");
    } else if (pick === configureLabel) {
      void vscode.commands.executeCommand("omnicopilot.manage");
    }
  }
}

export function deactivate(): void {
  for (const d of providerDisposables) {
    d.dispose();
  }
  providerDisposables = [];
  activeProviders = [];
  statusBar = undefined;
  panel = undefined;
}
