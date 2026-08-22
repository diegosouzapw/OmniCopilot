/** Canonical endpoint capabilities advertised by OmniRoute model metadata. */
export type SupportedEndpointClass =
  | "responses"
  | "chatCompletions"
  | "completions"
  | "messages"
  | "specialty"
  | "unknown";

const HTTP_METHOD = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i;

const ENDPOINT_CLASSES = new Map<string, Exclude<SupportedEndpointClass, "unknown">>([
  ["/responses", "responses"],
  ["/chat/completions", "chatCompletions"],
  ["/completions", "completions"],
  ["/messages", "messages"],
  ["/messages/count_tokens", "specialty"],
  ["/search", "specialty"],
  ["/search/analytics", "specialty"],
  ["/rerank", "specialty"],
  ["/audio", "specialty"],
  ["/image", "specialty"],
  ["/video", "specialty"],
  ["/moderation", "specialty"],
  ["/tts", "specialty"],
  ["/stt", "specialty"],
  ["/speech", "specialty"],
  ["/transcription", "specialty"],
  ["/translation", "specialty"],
  ["/embeddings", "specialty"],
  ["/embedding", "specialty"],
  ["/images/generations", "specialty"],
  ["/image/generations", "specialty"],
  ["/audio/speech", "specialty"],
  ["/audio/transcriptions", "specialty"],
  ["/audio/translations", "specialty"],
  ["/moderations", "specialty"],
  ["/videos/generations", "specialty"],
  ["/video/generations", "specialty"],
]);

/**
 * Normalize one `supported_endpoints` value into a comparable path.
 *
 * This intentionally removes only a leading `/v1`. Arbitrary path prefixes
 * remain intact so a deceptive value such as `/proxy/v1/chat/completions`
 * cannot acquire a conversational capability by suffix matching.
 */
export function normalizeSupportedEndpoint(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let value = raw.trim().replace(HTTP_METHOD, "").trim();
  if (!value) return "";

  try {
    if (/^https?:\/\//i.test(value)) value = new URL(value).pathname;
  } catch {
    return "";
  }

  const cleanPath = value.split(/[?#]/, 1)[0].replaceAll("\\", "/");
  const segments = cleanPath.split("/").filter(Boolean);
  if (segments.length > 0 && segments[0].toLowerCase() === "v1") {
    segments.shift();
  }
  return segments.length > 0
    ? `/${segments.join("/").toLowerCase()}`
    : "/";
}

/** Classify only exact, known canonical endpoints. */
export function classifySupportedEndpoint(raw: unknown): SupportedEndpointClass {
  return ENDPOINT_CLASSES.get(normalizeSupportedEndpoint(raw)) ?? "unknown";
}

/** Classify a metadata list once for shared catalog and transport decisions. */
export function classifySupportedEndpoints(
  endpoints: readonly unknown[]
): ReadonlySet<SupportedEndpointClass> {
  return new Set(
    endpoints
      .filter((endpoint): endpoint is string => typeof endpoint === "string")
      .map(classifySupportedEndpoint)
  );
}
