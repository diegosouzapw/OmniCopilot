/**
 * Catalog shaping — pure helpers, split out of provider.ts so they can be unit
 * tested without a `vscode` runtime.
 *
 * Two things the raw `GET /v1/models` payload carries that the Copilot Chat
 * picker must not show:
 *
 * 1. **Non-chat models.** OmniRoute's catalog also lists specialty registries
 *    (audio, image, embedding, rerank, video, moderation). They answer on other
 *    endpoints, so picking one in chat fails on the first message.
 * 2. **Duplicate mirrors.** OmniRoute defaults to `MODELS_CATALOG_PREFIX_MODE=dual`,
 *    advertising both the short alias prefix and the canonical provider prefix
 *    (`cc/claude-sonnet-4-6` *and* `claude/claude-sonnet-4-6`) for backward
 *    compatibility. The mirror row points at the primary via `parent`.
 *    We ask for `?prefix=alias` so the server sends one id per model; this is
 *    the fallback for servers too old to honor that parameter.
 */

import type { OmniRouteModel } from "./types";
import { classifySupportedEndpoints } from "./supportedEndpoints";

/** Type strings that unambiguously name a non-chat registry. An unknown type
 * (e.g. `"llm"` on some builds) or an absent one is treated as conversational:
 * a server-version skew must never silently empty a route's picker. */
const SPECIALTY_TYPES = new Set([
  "audio",
  "image",
  "embedding",
  "rerank",
  "video",
  "moderation",
  "tts",
  "stt",
  "search",
  "searches",
  "transcription",
  "transcriptions",
  "translation",
  "translations",
  "speech",
  "speeches",
]);

/**
 * Chat rows carry no `type` at all; a typed row is a specialty model, and the
 * server rejects those outright ("… is an image-generation model and cannot be
 * used on /v1/chat/completions", HTTP 400).
 *
 * Only KNOWN specialty types are dropped. Exact normalized endpoint classes
 * are consulted as a backstop. Unknown values remain eligible for forward
 * compatibility, but known specialty-only and legacy-Completions-only rows
 * are excluded because this extension has no transport for those surfaces.
 */
export function isChatModel(model: OmniRouteModel): boolean {
  const type = (model.type ?? "").trim().toLowerCase();
  if (SPECIALTY_TYPES.has(type)) return false;

  const endpoints = model.supported_endpoints;
  if (Array.isArray(endpoints) && endpoints.length > 0) {
    const classes = classifySupportedEndpoints(endpoints);
    if (
      classes.has("responses") ||
      classes.has("chatCompletions") ||
      classes.has("messages")
    ) {
      return true;
    }
    return classes.size === 1 && classes.has("unknown");
  }
  return true;
}

/**
 * Drop specialty models and duplicate-prefix mirrors, preserving order.
 *
 * A row is a mirror only when its `parent` names a *different* id that is also
 * present in the same response — so a `parent` pointing at an absent model (or
 * at itself) never costs us an entry.
 */
export function selectChatModels(models: readonly OmniRouteModel[]): OmniRouteModel[] {
  const listedIds = new Set<string>();
  const byId = new Map<string, OmniRouteModel>();
  for (const model of models) {
    if (model?.id) {
      listedIds.add(model.id);
      byId.set(model.id, model);
    }
  }

  const out: OmniRouteModel[] = [];
  for (const model of models) {
    if (!model?.id) continue;
    if (!isChatModel(model)) continue;
    if (model.parent && model.parent !== model.id && listedIds.has(model.parent)) {
      const parent = byId.get(model.parent);
      // A mirror is a duplicate of a present primary. But when the "parent"
      // points straight back at this row (a cyclic/misconfigured dual-prefix
      // pair), dropping both would silently wipe the whole catalog — keep
      // each row instead of losing the model.
      if (parent?.parent !== model.id) continue;
    }
    out.push(model);
  }
  return out;
}
