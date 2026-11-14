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
  { id: "gemini", label: "Gemini CLI", description: "Google Gemini CLI — native endpoint", subcommand: "setup-gemini" },
  { id: "zed", label: "Zed", description: "Zed editor — OpenAI-compatible provider", subcommand: "setup-zed" },
  { id: "whycodes", label: "WhyCodes", description: "WhyCodes agent — config.toml provider", subcommand: "setup-whycodes" },
  { id: "5dive", label: "5dive", description: "5dive agent fleet — auth profile for claude seats", subcommand: "setup-5dive" },
];

const TERMINAL_NAME = "OmniRoute Setup";

function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const POWERSHELL = /^(pwsh|powershell)(\.exe)?$/i;
const QUOTED_EXECUTABLE_PATH = /^[\w@%+=:,./\\ ~()-]+$/;
const COMMAND_WITH_ARGS = /^[\w@%+=:,./\\ ~-]+$/;

/**
 * `omnicopilot.cliPath` is typed into a shell, so it is validated and, when it
 * is a quoted executable path, quoted again for the terminal's own shell.
 * - `"C:\\Program Files (x86)\\x.cmd"` or `'/opt/my tools/x'`: ONE executable path.
 *   The pair of quotes is stripped; the inside may hold parentheses but no quote,
 *   backtick, `$`, `;`, `&`, `|`, `<`, `>` or line break.
 * - `omniroute`, `npx omniroute`: a command with optional arguments, used as
 *   written; no parentheses and no quotes.
 * - Anything else is refused.
 */
export function resolveCliCommand(
  cliPath: string,
  shell: { platform: NodeJS.Platform; shellPath?: string }
): { ok: true; command: string } | { ok: false } {
  const value = cliPath.trim();
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    const path = value.slice(1, -1);
    if (!QUOTED_EXECUTABLE_PATH.test(path)) return { ok: false };
    const quoted = shellQuote(path, shell.platform);
    // PowerShell runs a quoted path only with the call operator; cmd.exe must not get it.
    const shellName = (shell.shellPath ?? "").split(/[\\/]/).pop() ?? "";
    const needsCallOperator = shell.platform === "win32" && POWERSHELL.test(shellName);
    return { ok: true, command: needsCallOperator ? `& ${quoted}` : quoted };
  }
  return COMMAND_WITH_ARGS.test(value) ? { ok: true, command: value } : { ok: false };
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
  const cli = resolveCliCommand(cliPath, {
    platform: process.platform,
    shellPath: vscode.env.shell,
  });
  if (!cli.ok) {
    log.warn("omnicopilot.cliPath rejected: it contains characters that are not allowed");
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "omnicopilot.cliPath contains characters that are not allowed in a command. Set it to the path of the OmniRoute CLI, in quotes if the path has spaces."
      )
    );
    return;
  }

  const connection = await resolveConnection(context);
  const root = serverRootUrl(connection.baseUrl);
  // A key withheld for this origin is not handed to the terminal either.
  const apiKey = connection.apiKey;

  const args = [tool.subcommand];
  if (!isLoopbackOrigin(connection.origin)) {
    args.push("--remote", shellQuote(root));
  }

  const command = `${cli.command} ${args.join(" ")}`;
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
