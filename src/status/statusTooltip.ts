import * as vscode from "vscode";
import { fmtTokens, type TokenProvenanceTotals } from "../metrics";
import type { StatusServer, StatusSnapshot } from "./statusRenderer";

/** Tooltip internals beyond the pure renderer: needs vscode for
 * MarkdownString + l10n. Lives apart so statusBar.ts stays a thin adapter. */

export interface TooltipTotals {
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalReasoningTokens: number;
  inputTokenProvenance?: TokenProvenanceTotals;
  outputTokenProvenance?: TokenProvenanceTotals;
  totalRequests: number;
}

export function buildStatusTooltip(
  snap: StatusSnapshot,
  main: string,
  totals: TooltipTotals | undefined
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;

  md.appendMarkdown(`### $(symbol-enum-member) OmniRoute\n`);
  md.appendMarkdown(`**${main}**\n\n`);

  appendActiveRequest(md, snap);
  appendLastError(md, snap);
  appendTokenMetrics(md, totals);
  appendLastRequest(md, snap);
  appendServers(md, snap);

  md.appendMarkdown(`---\n`);
  md.appendMarkdown(`*$(info) ${vscode.l10n.t("Click to open status & metrics popup.")}*`);
  return md;
}

/** One-line markdown for a connected server: icon, name, status, latency and
 * token/request tally when the server has traffic. */
function serverLine(s: StatusServer): string {
  const icon = s.online ? "$(check)" : "$(circle-slash)";
  const statusText = s.online ? vscode.l10n.t("Online") : vscode.l10n.t("Offline");
  let detail = "";
  if (typeof s.latencyMs === "number") detail += ` — ${s.latencyMs}ms`;
  if (s.tokens > 0) detail += ` · \`${fmtTokens(s.tokens)}\` (${s.requests} reqs)`;
  return `- ${icon} **${s.name}** (${statusText})${detail}\n`;
}

function appendActiveRequest(md: vscode.MarkdownString, snap: StatusSnapshot): void {
  if (snap.activeRequestCount <= 0) return;
  md.appendMarkdown(`#### $(sync~spin) ${vscode.l10n.t("Active Request")}\n`);
  md.appendMarkdown(
    `- **${vscode.l10n.t("Model")}:** \`${snap.activeModel ?? "…"}\` (${snap.activeRequestCount} in flight)\n\n`
  );
}

function appendLastError(md: vscode.MarkdownString, snap: StatusSnapshot): void {
  if (!snap.lastError) return;
  md.appendMarkdown(`#### $(error) ${vscode.l10n.t("Last Error")}\n`);
  md.appendMarkdown(`- ${snap.lastError}\n\n`);
}

function appendTokenMetrics(md: vscode.MarkdownString, totals: TooltipTotals | undefined): void {
  if (!totals) return;
  const provenance = (value: TokenProvenanceTotals | undefined) =>
    `${vscode.l10n.t("reported")}: \`${fmtTokens(value?.reported ?? 0)}\` · ` +
    `${vscode.l10n.t("estimated")}: \`${fmtTokens(value?.estimated ?? 0)}\` · ` +
    `${vscode.l10n.t("unknown")}: \`${fmtTokens(value?.unknown ?? 0)}\``;
  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(`#### $(graph) ${vscode.l10n.t("Token Metrics")}\n`);
  md.appendMarkdown(
    `- **${vscode.l10n.t("Total Tokens")}:** \`${fmtTokens(totals.totalTokens)}\` (${vscode.l10n.t("Input")}: \`${fmtTokens(totals.totalInputTokens)}\` · ${vscode.l10n.t("Output")}: \`${fmtTokens(totals.totalOutputTokens)}\`)\n`
  );
  if (totals.totalCachedTokens > 0 || totals.totalReasoningTokens > 0) {
    const extras: string[] = [];
    if (totals.totalCachedTokens > 0) {
      extras.push(`**${vscode.l10n.t("Cached Input")}:** \`${fmtTokens(totals.totalCachedTokens)}\``);
    }
    if (totals.totalReasoningTokens > 0) {
      extras.push(`**${vscode.l10n.t("Reasoning Output")}:** \`${fmtTokens(totals.totalReasoningTokens)}\``);
    }
    md.appendMarkdown(`- ${extras.join(" · ")}\n`);
  }
  md.appendMarkdown(`- **${vscode.l10n.t("Input Provenance")}:** ${provenance(totals.inputTokenProvenance)}\n`);
  md.appendMarkdown(`- **${vscode.l10n.t("Output Provenance")}:** ${provenance(totals.outputTokenProvenance)}\n`);
  md.appendMarkdown(
    `- **${vscode.l10n.t("Total Requests")}:** \`${totals.totalRequests}\`\n\n`
  );
}

function appendLastRequest(md: vscode.MarkdownString, snap: StatusSnapshot): void {
  if (!snap.usage) return;
  md.appendMarkdown(`#### $(zap) ${vscode.l10n.t("Last Request")}\n`);
  md.appendMarkdown(
    `- **${vscode.l10n.t("Server")}:** ${snap.usage.serverName} (${snap.usage.modelName})\n`
  );
  md.appendMarkdown(
    `- **${vscode.l10n.t("Tokens")}:** \`${fmtTokens(snap.usage.inputTokens + snap.usage.outputTokens)}\` (In: \`${fmtTokens(snap.usage.inputTokens)}\` [${snap.usage.inputTokenProvenance}] · Out: \`${fmtTokens(snap.usage.outputTokens)}\` [${snap.usage.outputTokenProvenance}])\n`
  );
  const extras: string[] = [];
  if ((snap.usage.cachedTokens ?? 0) > 0) {
    extras.push(`**${vscode.l10n.t("Cached Input")}:** \`${fmtTokens(snap.usage.cachedTokens ?? 0)}\``);
  }
  if ((snap.usage.reasoningTokens ?? 0) > 0) {
    extras.push(`**${vscode.l10n.t("Reasoning Output")}:** \`${fmtTokens(snap.usage.reasoningTokens ?? 0)}\``);
  }
  if (extras.length > 0) {
    md.appendMarkdown(`- ${extras.join(" · ")}\n`);
  }
  md.appendMarkdown(`\n`);
}

function appendServers(md: vscode.MarkdownString, snap: StatusSnapshot): void {
  if (snap.servers.length === 0) return;
  md.appendMarkdown(`#### $(server) ${vscode.l10n.t("Connected Servers")}\n`);
  for (const s of snap.servers) {
    md.appendMarkdown(serverLine(s));
  }
  if (snap.fallbackCount > 0) {
    md.appendMarkdown(
      `\n_$(repo-pull) ${vscode.l10n.t("Last request used {0} fallback server(s).", String(snap.fallbackCount))}_`
    );
  }
  md.appendMarkdown(`\n`);
}
