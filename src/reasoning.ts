import type { OmniRouteModel } from "./types";

/**
 * OmniRoute's canonical reasoning vocabulary
 * (`src/shared/reasoning/effortStandardization.ts` in the server repo).
 *
 * Sending a canonical value is what makes this portable: the per-provider
 * mappers downshift a tier a model does not support (e.g. `xhigh` ÔåÆ `high` for
 * Claude), so a caller can always ask for the top tier without knowing which
 * models implement it.
 */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Synonyms editors and users type. `extra`/`max` are the server's own aliases
 * for the top tier; `minimal` is OpenAI's lowest thinking tier, which has no
 * canonical equivalent ÔÇö it maps to `low` rather than being forwarded verbatim,
 * because a non-canonical string would reach providers that reject it.
 */
const EFFORT_ALIASES: Record<string, ReasoningEffort> = {
  extra: "xhigh",
  max: "xhigh",
  ultra: "xhigh",
  minimal: "low",
  min: "low",
  off: "none",
  none: "none",
  disabled: "none",
};

/** Normalize an arbitrary value onto the canonical set. Returns `undefined` for
 * anything unrecognized, so the caller leaves the request untouched instead of
 * forwarding a string the upstream would reject. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== "string") return undefined;
  const lowered = value.trim().toLowerCase();
  if (!lowered) return undefined;
  if (lowered in EFFORT_ALIASES) return EFFORT_ALIASES[lowered];
  return (REASONING_EFFORTS as readonly string[]).includes(lowered)
    ? (lowered as ReasoningEffort)
    : undefined;
}

/** Whether the catalog advertises extended thinking for this model. Both flags
 * exist because providers disagree on the name; either one counts. */
export function isReasoningModel(model: Pick<OmniRouteModel, "capabilities">): boolean {
  const caps = model.capabilities ?? {};
  return caps.reasoning === true || caps.thinking === true;
}

/**
 * Resolve the effort for one request.
 *
 * The editor's per-request value always wins ÔÇö VS Code may surface an effort
 * picker next to the model name, and an explicit user choice must not be
 * overridden by a workspace default. The configured default only applies to
 * models the catalog marks as reasoning-capable: sending `reasoning_effort` to
 * a model without thinking support is at best ignored and at worst a 400.
 */
export function resolveReasoningEffort(options: {
  modelOptions?: Record<string, unknown>;
  configuredDefault?: string;
  modelIsReasoning: boolean;
}): ReasoningEffort | undefined {
  const mo = options.modelOptions ?? {};
  const fromEditor =
    normalizeReasoningEffort(mo.reasoning_effort) ??
    normalizeReasoningEffort(mo.reasoningEffort) ??
    normalizeReasoningEffort((mo.reasoning as Record<string, unknown> | undefined)?.effort) ??
    normalizeReasoningEffort(mo.effort);
  if (fromEditor) return fromEditor;
  if (!options.modelIsReasoning) return undefined;
  return normalizeReasoningEffort(options.configuredDefault);
}
