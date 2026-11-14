import * as vscode from "vscode";
import { serverRootUrl } from "./client";
import { isLoopbackOrigin, resolveConnection } from "./connection";

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
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

  const cfg = vscode.workspace.getConfiguration("omnicopilot");
  const cliPath = cfg.get<string>("cliPath", "omniroute").trim() || "omniroute";
  const connection = await resolveConnection(context);
  const root = serverRootUrl(connection.baseUrl);
  // A key withheld for this origin is not handed to the terminal either.
  const apiKey = connection.apiKey;

  const args = [tool.subcommand];
  if (!isLoopbackOrigin(connection.origin)) {
    args.push("--remote", shellQuote(root));
  }

  const command = `${cliPath} ${args.join(" ")}`;
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
