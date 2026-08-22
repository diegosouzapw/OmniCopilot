/** Shapes exchanged with the OmniRoute OpenAI-compatible API. */

/** One entry of GET /v1/models. OmniRoute enriches the OpenAI shape with
 * capabilities and context metadata; every extra field is optional so the
 * extension also works against vanilla OpenAI-compatible servers. */
export interface OmniRouteModel {
  id: string;
  object?: string;
  owned_by?: string;
  display_name?: string;
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
  context_length?: number;
  max_completion_tokens?: number;
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

export interface SearchRequest {
  query: string;
  provider?: string;
  max_results: number;
  search_type: "web" | "news";
}

export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;
  return_documents?: boolean;
}

/** One configured server entry (URLs live in config; the API key in secrets). */
export interface RouteConfig {
  id: string;
  name: string;
  baseUrl: string;
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
  stream_options?: {
    include_usage?: boolean;
  };
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

/** Wire protocol used for one model request. Responses is preferred unless
 * catalog metadata explicitly limits a model to Chat Completions or Messages. */
export type ModelTransport = "responses" | "chatCompletions" | "messages";

/** Ordered protocols that may be tried for one model before any output is
 * emitted. This never includes legacy `/completions`. */
export type ModelTransportPlan = readonly ModelTransport[];

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

export interface ResponsesMessageItem {
  type: "message";
  role: "system" | "developer" | "user" | "assistant";
  content: ResponsesContentPart[];
}

export interface ResponsesFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  stream: true;
  tools?: ResponsesFunctionTool[];
  tool_choice?: "auto" | "required" | "none";
  temperature?: number;
  max_output_tokens?: number;
  reasoning?: { effort: string };
}

export type MessagesContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface MessagesRequest {
  model: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: MessagesContentBlock[] }>;
  stream: true;
  max_tokens: number;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: "auto" | "any" };
  temperature?: number;
}

/** Minimal Anthropic Messages streaming event subset consumed by the client. */
export interface MessagesStreamEvent {
  type?: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  error?: { type?: string; message?: string };
}

/** Minimal subset of Responses streaming events consumed by the extension. */
export interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    error?: { message?: string; code?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_tokens_details?: {
        cached_tokens?: number;
      };
      output_tokens_details?: {
        reasoning_tokens?: number;
      };
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  error?: { message?: string; code?: string };
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
  reasoning_content?: string | null;
  reasoning?: string | null;
  thinking?: string | null;
  tool_calls?: StreamToolCallDelta[];
}

export interface StreamChunk {
  choices?: Array<{
    delta?: StreamDelta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  error?: { message?: string };
}

/** Structured token usage returned by upstream streams. */
export interface ChatUsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

/** Normalized streaming events yielded by the client. */
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; id: string; name: string; args: string }
  | { kind: "usage"; usage: ChatUsageInfo };
