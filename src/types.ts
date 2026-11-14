/** Shapes exchanged with the OmniRoute OpenAI-compatible API. */

/** One entry of GET /v1/models. OmniRoute enriches the OpenAI shape with
 * capabilities and context metadata; every extra field is optional so the
 * extension also works against vanilla OpenAI-compatible servers. */
export interface OmniRouteModel {
  id: string;
  object?: string;
  owned_by?: string;
  display_name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  /** Absent (or "chat") for conversational models; "audio", "image",
   * "embedding", "rerank", "video", "moderation"… for specialty registries
   * that must never reach the Copilot Chat picker. */
  type?: string;
  /** Endpoints the model answers on. When present and missing "chat", the
   * model is not usable from a chat request. */
  supported_endpoints?: string[];
  /** Set on a duplicate id that mirrors another entry in the same response
   * (OmniRoute `dual` prefix mode). Points at the primary id. */
  parent?: string | null;
  capabilities?: {
    tool_calling?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    structured_output?: boolean;
    thinking?: boolean;
    [key: string]: unknown;
  };
}

export interface ModelsResponse {
  object: string;
  data: OmniRouteModel[];
}

/** OpenAI Chat Completions request/stream shapes (subset we use). */

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: true;
  /** Ask for the final usage chunk (OpenAI-compatible). */
  stream_options?: { include_usage: boolean };
  tools?: ChatTool[];
  tool_choice?: "auto" | "required";
  temperature?: number;
  max_tokens?: number;
  /** Canonical reasoning tier (none/low/medium/high/xhigh). OmniRoute maps it
   * onto each provider's own field — reasoning_effort, reasoning.effort or a
   * thinking budget — and an explicit value here always wins over its own
   * heuristics. Plain OpenAI-compatible servers read it natively. */
  reasoning_effort?: string;
}

/** Incremental tool-call fragment inside a stream delta. */
export interface StreamToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface StreamDelta {
  content?: string | null;
  tool_calls?: StreamToolCallDelta[];
}

/** Token accounting as reported by an OpenAI-compatible server. */
export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** Anthropic-style names some gateways use. */
  input_tokens?: number;
  output_tokens?: number;
}

export interface StreamChunk {
  /** Present on the final chunk when `stream_options.include_usage` is set;
   * some servers send it with an empty `choices` array. */
  usage?: StreamUsage | null;
  choices?: Array<{
    delta?: StreamDelta;
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}

/** Normalized streaming events yielded by the client. */
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; id: string; name: string; args: string }
  | { kind: "usage"; usage: StreamUsage };
