/** Pure, framework-free description of what the status bar should render.
 * Produced by the adapter (statusBar.ts), rendered here so the presentation
 * logic stays unit-testable without the VS Code API. */

import type { ResolvedChatUsage } from "../usage";

export type StatusKind =
  | "checking"
  | "online"
  | "partial"
  | "offline"
  | "streaming"
  | "error";

export interface StatusServer {
  routeId: string;
  name: string;
  online: boolean;
  latencyMs?: number;
  tokens: number;
  requests: number;
}

export interface StatusSnapshot {
  status: StatusKind;
  servers: StatusServer[];
  /** Most recent chat round-trip (model + token counts). */
  usage?: Omit<ResolvedChatUsage, "routeId" | "baseUrl">;
  /** Final failure message of the last request, when it errored out. */
  lastError?: string;
  lastResponseAt?: number;
  /** In-flight chat requests across all provider slots. */
  activeRequestCount: number;
  /** Model currently streaming, when any. */
  activeModel?: string;
  /** How many fallback servers were tried during the last request. */
  fallbackCount: number;
}

/** One-line status-bar text: icon + server tally + avg latency + token readout. */
export function renderStatusText(snap: StatusSnapshot): string {
  let icon = "$(circle-filled)";
  switch (snap.status) {
    case "offline":
      icon = "$(circle-outline)";
      break;
    case "checking":
      icon = "$(sync~spin)";
      break;
    case "streaming":
      icon = "$(loading~spin)";
      break;
    case "error":
      icon = "$(error)";
      break;
    case "online":
    case "partial":
      break;
  }

  let text = `${icon} OmniRoute`;
  const online = snap.servers.filter((s) => s.online).length;
  if (snap.servers.length > 0) {
    text += ` ${online}/${snap.servers.length}`;
  }
  return text;
}

/** Theme-color tokens by state; the adapter maps them to vscode.ThemeColor. */
export function statusColorTokens(snap: StatusSnapshot): { color?: string; background?: string } {
  switch (snap.status) {
    case "online":
      return { color: "testing.iconPassed" };
    case "partial":
      return { color: "testing.iconWarning" };
    case "offline":
      return { background: "statusBarItem.warningBackground" };
    case "error":
      return { color: "testing.iconFailed" };
    default:
      return {};
  }
}
