import * as vscode from "vscode";
import { serverRootUrl } from "./client";
import { cachedLoadRoutes } from "./routes";

interface CliTool {
  id: string;
  label: string;
  description: string;
  /** `omniroute <subcommand>` that writes the tool's profiles/config. */
  subcommand: string;
}

/** Coding CLIs the OmniRoute CLI can configure (omniroute setup-*). */
export const CLI_TOOLS: CliTool[] = [
  { id: "codex", label: "Codex CLI", description: "OpenAI Codex — ~/.codex profiles", subcommand: "setup-codex" },
  { id: "claude", label: "Claude Code", description: "Anthropic Claude Code — launch profiles", subcommand: "setup-claude" },
  { id: "cline", label: "Cline", description: "VS Code agent extension", subcommand: "setup-cline" },
  { id: "continue", label: "Continue", description: "VS Code / JetBrains assistant", subcommand: "setup-continue" },
  { id: "cursor", label: "Cursor", description: "Cursor editor", subcommand: "setup-cursor" },
  { id: "aider", label: "Aider", description: "Terminal pair-programmer", subcommand: "setup-aider" },
  { id: "opencode", label: "OpenCode", description: "OpenCode CLI", subcommand: "setup-opencode" },
  { id: "goose", label: "Goose", description: "Block Goose agent", subcommand: "setup-goose" },
  { id: "crush", label: "Crush", description: "Charm Crush CLI", subcommand: "setup-crush" },
  { id: "qwen", label: "Qwen Code", description: "Qwen coding CLI", subcommand: "setup-qwen" },
  { id: "kilo", label: "Kilo Code", description: "Kilo Code extension", subcommand: "setup-kilo" },
  { id: "roo", label: "Roo Code", description: "Roo Code extension", subcommand: "setup-roo" },
];

const TERMINAL_NAME = "OmniRoute Setup";

function shellQuote(value: string): string {
  const sanitized = value.replace(/[\r\n]/g, "");
  if (process.platform === "win32") {
    const escaped = sanitized.replace(/["^\\]/g, String.raw`\$&`);
    return `"${escaped}"`;
  }
  // POSIX: escape every ' as '\'' so the value survives a single-quoted
  // argument. String.raw keeps the backslash literal (no double escaping).
  const escaped = sanitized.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}

/**
 * "Configure Coding CLI" flow: pick a tool → run `omniroute setup-<tool>`
 * against the extension's configured server in the integrated terminal.
 * The API key travels through the OMNIROUTE_API_KEY env var the CLI already
 * honors — it never appears on the command line.
 */
export async function configureCliTool(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  preselectedToolId?: string
): Promise<void> {
  const tool = preselectedToolId
    ? CLI_TOOLS.find((t) => t.id === preselectedToolId)
    : await pickTool();
  if (!tool) return;

  const routes = await cachedLoadRoutes(context);
  if (routes.length === 0) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("Add an OmniRoute server in the panel before configuring a coding CLI.")
    );
    return;
  }
  let route = routes[0];
  if (routes.length > 1) {
    const picked = await vscode.window.showQuickPick(
      routes.map((r) => ({ label: r.name, description: serverRootUrl(r.baseUrl), route: r })),
      { title: vscode.l10n.t("OmniRoute: pick a server for {0}", tool.label) }
    );
    if (!picked) return;
    route = picked.route;
  }

  const cfg = vscode.workspace.getConfiguration("omnicopilot");
  const configuredCliPath = cfg.get<string>("cliPath", "omniroute").trim();
  if (/[&|;$`\r\n<>"'()^%!\\]/.test(configuredCliPath)) {
    void vscode.window.showErrorMessage(vscode.l10n.t("Invalid CLI path: shell metacharacters are not allowed."));
    return;
  }
  const cliPath = shellQuote(configuredCliPath || "omniroute");
  const root = serverRootUrl(route.baseUrl);
  const apiKey = route.apiKey;

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(root);
  const args = [tool.subcommand];
  if (!isLocal) {
    args.push("--remote", shellQuote(root));
  }

  const command = process.platform === "win32" && cliPath.startsWith('"')
    ? `& ${cliPath} ${args.join(" ")}`
    : `${cliPath} ${args.join(" ")}`;
  log.info(`Running in terminal: ${command}${apiKey ? " (API key via env)" : ""}`);

  const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
  existing?.dispose();
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    env: apiKey ? { OMNIROUTE_API_KEY: apiKey } : undefined,
  });
  terminal.show(true);
  terminal.sendText(command, true);

  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Configuring {0} through the OmniRoute CLI. If the command is not found, install it with "npm i -g omniroute" or set omnicopilot.cliPath.',
      tool.label
    )
  );
}

async function pickTool(): Promise<CliTool | undefined> {
  const picked = await vscode.window.showQuickPick(
    CLI_TOOLS.map((t) => ({
      label: t.label,
      description: t.description,
      detail: `omniroute ${t.subcommand}`,
      tool: t,
    })),
    {
      title: vscode.l10n.t("OmniRoute: configure a coding CLI"),
      placeHolder: vscode.l10n.t("Which tool should use OmniRoute models?"),
      matchOnDescription: true,
    }
  );
  return picked?.tool;
}
