import * as vscode from "vscode";
import { DEFAULT_BASE_URL, OmniRouteClient, serverRootUrl } from "./client";
import { configureCliTool } from "./cliBridge";
import { OmniPanelProvider } from "./panel";
import { OmniRouteChatProvider, SECRET_API_KEY } from "./provider";
import { ConnectionStatusBar } from "./statusBar";

const OMNIROUTE_REPO = "https://github.com/diegosouzapw/OmniRoute";
const VENDOR = "omniroute";

let provider: OmniRouteChatProvider | undefined;
let statusBar: ConnectionStatusBar | undefined;
let panel: OmniPanelProvider | undefined;

function getConfig() {
  return vscode.workspace.getConfiguration("omnicopilot");
}

async function makeClient(context: vscode.ExtensionContext): Promise<OmniRouteClient> {
  const baseUrl = getConfig().get<string>("baseUrl", DEFAULT_BASE_URL);
  const apiKey = await context.secrets.get(SECRET_API_KEY);
  return new OmniRouteClient({ baseUrl, apiKey: apiKey || undefined });
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("OmniRoute for Copilot", { log: true });
  context.subscriptions.push(log);
  log.info(`Activating v${context.extension.packageJSON.version}`);

  statusBar = new ConnectionStatusBar(() => makeClient(context), log);
  context.subscriptions.push(statusBar);

  provider = new OmniRouteChatProvider({
    context,
    log,
    onActivity: (ok) => statusBar?.reportActivity(ok),
  });
  context.subscriptions.push(provider);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));
  log.info(`Language model chat provider registered (vendor: ${VENDOR})`);

  panel = new OmniPanelProvider(context, log, async () => {
    statusBar?.restart();
    await provider?.refresh();
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OmniPanelProvider.viewId, panel)
  );

  registerCommands(context, log);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("omnicopilot")) return;
      log.info("Configuration changed — refreshing models and status");
      statusBar?.restart();
      void provider?.refresh();
      void panel?.refreshStatus();
    })
  );

  statusBar.start();
  void checkFirstRun(context, log);
}

function registerCommands(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // The management gear in "Manage Models" and the status-bar menu both land
  // on the visual panel (Activity Bar view) where URL + API key live.
  register("omnicopilot.manage", () => panel?.focus());
  register("omnicopilot.openSettings", () =>
    vscode.commands.executeCommand("workbench.action.openSettings", "omnicopilot")
  );
  register("omnicopilot.setApiKey", () => setApiKey(context, log));

  register("omnicopilot.refreshModels", async () => {
    await provider?.refresh();
    void vscode.window.showInformationMessage(vscode.l10n.t("OmniRoute model list refreshed."));
  });

  register("omnicopilot.checkConnection", async () => {
    const ok = await statusBar?.checkNow();
    if (ok) {
      const client = await makeClient(context);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Connected to OmniRoute at {0}.", client.baseUrl)
      );
    } else {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "OmniRoute is unreachable. Check that it is running (npx omniroute) and that omnicopilot.baseUrl points at it."
        )
      );
    }
  });

  register("omnicopilot.openDashboard", async () => {
    const root = serverRootUrl(getConfig().get<string>("baseUrl", DEFAULT_BASE_URL));
    const mode = getConfig().get<string>("dashboardOpen", "external");
    if (mode === "editor") {
      // The Simple Browser is an iframe, so the server must allow framing.
      // Probing first matters: simpleBrowser.show SUCCEEDS against a server that
      // sends X-Frame-Options: DENY, leaving a "refused to connect" tab that the
      // catch below would never see.
      const client = await makeClient(context);
      if (await client.canEmbedDashboard()) {
        try {
          await vscode.commands.executeCommand("simpleBrowser.show", root);
          return;
        } catch (err) {
          log.warn(`Simple Browser unavailable, falling back to external: ${String(err)}`);
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

  register("omnicopilot.quickActions", () => quickActions(context));
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

/** Menu behind the status-bar item. */
async function quickActions(context: vscode.ExtensionContext): Promise<void> {
  const client = await makeClient(context);
  const online = await client.ping(1500);

  const items: Array<vscode.QuickPickItem & { action: string }> = [
    {
      label: online
        ? `$(circle-filled) ${vscode.l10n.t("Online")}`
        : `$(circle-outline) ${vscode.l10n.t("Offline")}`,
      description: client.baseUrl,
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
  const existing = await context.secrets.get(SECRET_API_KEY);
  const key = await vscode.window.showInputBox({
    title: vscode.l10n.t("OmniRoute API key"),
    prompt: optionalFlow
      ? vscode.l10n.t(
          "Optional — leave empty if your OmniRoute does not require an API key. Stored in the OS keychain."
        )
      : vscode.l10n.t("Stored securely in the OS keychain (SecretStorage). Leave empty to clear."),
    value: existing ?? "",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;

  if (key.trim()) {
    await context.secrets.store(SECRET_API_KEY, key.trim());
    log.info("API key stored in SecretStorage");
  } else if (existing) {
    await context.secrets.delete(SECRET_API_KEY);
    log.info("API key cleared");
  }
  if (!optionalFlow) await provider?.refresh();
}

/** One-time welcome: point users at the model picker or at installing OmniRoute. */
async function checkFirstRun(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  const FLAG = "omnicopilot.welcomed";
  if (context.globalState.get<boolean>(FLAG)) return;
  await context.globalState.update(FLAG, true);

  const client = await makeClient(context);
  const online = await client.ping();
  log.info(`First run — OmniRoute ${online ? "detected" : "not detected"} at ${client.baseUrl}`);

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
  provider = undefined;
  statusBar = undefined;
  panel = undefined;
}
