/**
 * OmniCopilot #14 — Agents window (Copilot CLI agent host) registration.
 *
 * VS Code's `chatProvider` proposal adds `targetChatSessionType` to
 * `LanguageModelChatInformation`: models carrying it are EXCLUDED from the
 * general model picker and appear only in sessions of that type. The value for
 * the Agents window's agent host is `agent-host-copilotcli` (verified against
 * the VS Code source and ltmoerdani/opencode-copilot-chat#11 — `copilotcli`
 * fails and `agent-host-copilot` misbehaves). Because the property excludes
 * the general picker, exposure is a SECOND set of entries alongside the
 * unscoped ones, never a mutation of them.
 *
 * The property is read by the host through duck typing — stable `@types/vscode`
 * doesn't declare it, and shipping `enabledApiProposals` would block a
 * Marketplace install — so this stays a plain optional field on our own entry
 * type. Users additionally need the experimental VS Code setting
 * `chat.agentHost.byokModels.enabled` plus an agent-host restart; hence the
 * whole feature is gated behind `omnicopilot.exposeToAgentsWindow` (default
 * off). Pure module: no vscode import, fully unit-testable.
 */

export const AGENT_HOST_SESSION_TYPE = "agent-host-copilotcli";

/** Suffix keeping the second entry's `id` unique next to the unscoped one. */
export const AGENTS_WINDOW_ID_SUFFIX = "::agents";

export interface AgentsWindowCandidate {
  id: string;
  tooltip?: string;
  /** Mirrors `LanguageModelChatCapabilities`: a number is a max-tool-count and
   * still means tool calling is supported. */
  capabilities?: { toolCalling?: number | boolean; imageInput?: boolean };
}

function supportsTools(info: AgentsWindowCandidate): boolean {
  const tc = info.capabilities?.toolCalling;
  return tc === true || (typeof tc === "number" && tc > 0);
}

/**
 * Return the picker entries plus, when the feature is enabled, one
 * agent-host-scoped clone per tool-calling model. Models without tool calling
 * are not cloned — an agent session cannot use them, so the clone would be
 * dead weight in the Agents window picker.
 */
export function expandForAgentsWindow<T extends AgentsWindowCandidate>(
  infos: readonly T[],
  enabled: boolean
): Array<T & { targetChatSessionType?: string }> {
  if (!enabled) return [...infos];

  const agentEntries = infos
    .filter(supportsTools)
    .map((info) => ({
      ...info,
      id: `${info.id}${AGENTS_WINDOW_ID_SUFFIX}`,
      tooltip: info.tooltip ? `${info.tooltip} · Agents window` : "Agents window",
      targetChatSessionType: AGENT_HOST_SESSION_TYPE,
    }));

  return [...infos, ...agentEntries];
}
