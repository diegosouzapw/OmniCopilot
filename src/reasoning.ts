import type { OmniRouteModel } from "./types";

/**
 * OmniRoute's canonical reasoning vocabulary
 * (`src/shared/reasoning/effortStandardization.ts` in the server repo).
 *
 * Sending a canonical value is what makes this portable: the per-provider
 * mappers downshift a tier a model does not support (e.g. `max` → `high` for
 * a model without it), so a caller can always ask for the top tier without
 * knowing which models implement it.
 */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Synonyms editors and users type. `ultra` is the server's name for the top
 * tier; `minimal` is OpenAI's lowest thinking tier, which has no canonical
 * equivalent — it maps to `low` rather than being forwarded verbatim, because
 * a non-canonical string would reach providers that reject it. `max` is a tier
 * of its own, not a synonym of `xhigh`.
 */
const EFFORT_ALIASES: Record<string, ReasoningEffort> = {
  extra: "xhigh",
  ultra: "max",
  minimal: "low",
  min: "low",
  off: "none",
  disabled: "none",
};

/**
 * Normalize an arbitrary value onto the vocabulary. A tier the model itself
 * advertises always wins, even outside the canonical list (some models offer
 * their own names). Returns `undefined` for anything unrecognized, so the
 * caller leaves the request untouched instead of forwarding a string the
 * upstream would reject.
 */
export function normalizeReasoningEffort(
  value: unknown,
  tiers?: readonly string[]
): string | undefined {
  if (typeof value !== "string") return undefined;
  const lowered = value.trim().toLowerCase();
  if (!lowered) return undefined;
  if (tiers?.includes(lowered)) return lowered;
  if (lowered in EFFORT_ALIASES) return EFFORT_ALIASES[lowered];
  return (REASONING_EFFORTS as readonly string[]).includes(lowered) ? lowered : undefined;
}

/** The tiers to offer for a model: what the catalog advertises, else the
 * canonical list. */
export function effortTiersFor(model: Pick<OmniRouteModel, "capabilities">): string[] {
  const advertised = (model.capabilities?.effort_tiers ?? []).filter(
    (tier): tier is string => typeof tier === "string" && tier.trim() !== ""
  );
  return advertised.length > 0 ? advertised : [...REASONING_EFFORTS];
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
 * The picker choice (`modelConfiguration`) comes first, then any per-request
 * value in `modelOptions`: an explicit user choice must not be overridden by a
 * workspace default. The configured default only applies to models the catalog
 * marks as reasoning-capable: sending `reasoning_effort` to a model without
 * thinking support is at best ignored and at worst a 400.
 */
export function resolveReasoningEffort(options: {
  modelConfiguration?: Record<string, unknown>;
  modelOptions?: Record<string, unknown>;
  configuredDefault?: string;
  modelIsReasoning: boolean;
  modelTiers?: readonly string[];
}): string | undefined {
  const tiers = options.modelTiers;
  const norm = (value: unknown) => normalizeReasoningEffort(value, tiers);
  const mo = options.modelOptions ?? {};
  const fromEditor =
    norm(options.modelConfiguration?.reasoningEffort) ??
    norm(mo.reasoning_effort) ??
    norm(mo.reasoningEffort) ??
    norm((mo.reasoning as Record<string, unknown> | undefined)?.effort) ??
    norm(mo.effort);
  if (fromEditor) return fromEditor;
  if (!options.modelIsReasoning) return undefined;
  return norm(options.configuredDefault);
}

export interface EffortSchema {
  properties: {
    reasoningEffort: {
      type: "string";
      title: string;
      enum: string[];
      enumItemLabels: string[];
      group: "navigation";
      default?: string;
    };
  };
}

/**
 * Per-model configuration schema for VS Code's model picker: a property with
 * an `enum` becomes a submenu next to the model, and the user's pick arrives in
 * `options.modelConfiguration.reasoningEffort`. `default` is set only when the
 * configured default, normalized, is one of the tiers; without it VS Code sends
 * nothing until the user picks, so the server keeps deciding.
 */
export function buildEffortSchema(
  tiers: readonly string[],
  text: { title: string; label(tier: string): string },
  defaultEffort?: string
): EffortSchema {
  const reasoningEffort: EffortSchema["properties"]["reasoningEffort"] = {
    type: "string",
    title: text.title,
    enum: [...tiers],
    enumItemLabels: tiers.map((tier) => text.label(tier)),
    group: "navigation",
  };
  const preselected = normalizeReasoningEffort(defaultEffort, tiers);
  if (preselected && tiers.includes(preselected)) reasoningEffort.default = preselected;
  return { properties: { reasoningEffort } };
}
