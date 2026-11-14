import type { OmniRouteModel } from "./types";

export interface ModelShapingConfig {
  /** `omnicopilot.maxOutputTokens`: the most output the user is willing to reserve. */
  maxOutputTokens: number;
  /** `omnicopilot.defaultContextLength`: used when the catalog omits the window. */
  defaultContextLength: number;
}

export interface ModelDescription {
  name: string;
  contextLength: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Tiers the catalog advertises; `undefined` when it advertises none. */
  effortTiers: string[] | undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Turn one catalog entry into the numbers and names the model picker needs.
 *
 * OmniRoute sends `name`, `max_output_tokens` and `max_input_tokens`;
 * `display_name` and `max_completion_tokens` are still read for servers that
 * use the OpenAI-style names.
 */
export function describeModel(model: OmniRouteModel, cfg: ModelShapingConfig): ModelDescription {
  const contextLength = model.context_length ?? cfg.defaultContextLength;
  const modelCeiling = positive(model.max_output_tokens) ?? positive(model.max_completion_tokens);
  // Never reserve more than half of the window: a small model with the default
  // 16k budget would otherwise be left with almost no room for the prompt.
  const maxOutputTokens = Math.min(
    modelCeiling ?? cfg.maxOutputTokens,
    cfg.maxOutputTokens,
    Math.floor(contextLength / 2)
  );
  const maxInputTokens = Math.max(
    Math.min(contextLength - maxOutputTokens, positive(model.max_input_tokens) ?? Infinity),
    1024
  );
  const tiers = (model.capabilities?.effort_tiers ?? []).filter(
    (tier): tier is string => typeof tier === "string" && tier.trim() !== ""
  );

  return {
    name: model.display_name?.trim() || model.name?.trim() || model.id,
    contextLength,
    maxInputTokens,
    maxOutputTokens,
    effortTiers: tiers.length > 0 ? tiers : undefined,
  };
}
