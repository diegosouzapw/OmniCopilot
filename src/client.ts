import { isFramingAllowed } from "./embed";
import type {
  ChatRequest,
  ModelsResponse,
  OmniRouteModel,
  StreamChunk,
  StreamEvent,
  StreamToolCallDelta,
} from "./types";

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
}

const USER_AGENT = "OmniCopilot-VSCode";

/** Server root the user configures — the `/v1` suffix is an implementation
 * detail this client appends, so it never leaks into settings or the UI. */
export const DEFAULT_BASE_URL = "http://localhost:20128";

function headers(apiKey: string | undefined, json: boolean): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": USER_AGENT };
  if (json) h["Content-Type"] = "application/json";
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

/** Normalize a user-supplied base URL for API calls: trim, drop trailing
 * slashes, ensure /v1. Accepts either form, so a stored `…:20128/v1` from an
 * older install keeps working without being doubled. */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw || "").trim().replace(/\/+$/, "");
  if (!url) return `${DEFAULT_BASE_URL}/v1`;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  if (!/\/v1$/i.test(url)) url = `${url}/v1`;
  return url;
}

/** Base URL without the /v1 suffix (dashboard, CLI --remote flag). */
export function serverRootUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/i, "");
}

/** Thin HTTP client for an OmniRoute (or any OpenAI-compatible) server. */
export class OmniRouteClient {
  constructor(private readonly opts: ClientOptions) {}

  get baseUrl(): string {
    return normalizeBaseUrl(this.opts.baseUrl);
  }

  /** Fast availability probe. OmniRoute serves HEAD /v1/models explicitly. */
  async ping(timeoutMs = 4000): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: "HEAD",
        headers: headers(this.opts.apiKey, false),
        signal: ctrl.signal,
      });
      return res.ok || res.status === 401 || res.status === 403;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether the dashboard may be framed by the VS Code Simple Browser.
   * Fails closed: an unreachable server is not embeddable either. */
  async canEmbedDashboard(timeoutMs = 4000): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(serverRootUrl(this.baseUrl), {
        method: "HEAD",
        redirect: "manual",
        headers: headers(this.opts.apiKey, false),
        signal: ctrl.signal,
      });
      return isFramingAllowed(res.headers);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(token?: { isCancellationRequested?: boolean }): Promise<OmniRouteModel[]> {
    // `?prefix=alias` asks OmniRoute for one id per model instead of its
    // default `dual` mode, which advertises BOTH the short alias prefix and
    // the canonical provider prefix (`cc/claude-…` *and* `claude/claude-…`)
    // for backward compatibility — that shows up as duplicates in the picker.
    // Alias mode is the safe direction: every model keeps an entry, whereas
    // `canonical` drops models whose provider has no distinct alias. Unknown
    // query params are ignored by other OpenAI-compatible servers.
    const res = await fetch(`${this.baseUrl}/models?prefix=alias`, {
      headers: headers(this.opts.apiKey, false),
    });
    if (!res.ok) {
      throw new Error(`OmniRoute /models returned HTTP ${res.status}`);
    }
    if (token?.isCancellationRequested) return [];
    const body = (await res.json()) as ModelsResponse;
    return Array.isArray(body.data) ? body.data : [];
  }

  /** POST /chat/completions with stream:true, yielding normalized events. */
  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(this.opts.apiKey, true),
      body: JSON.stringify(request),
      signal,
    });

    if (!res.ok || !res.body) {
      const detail = await safeErrorDetail(res);
      throw new Error(`OmniRoute request failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
    }

    const assembler = new ToolCallAssembler();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
          buffer = buffer.slice(newlineIdx + 1);
          yield* this.handleSseLine(line, assembler);
        }
      }
      // Flush any tool calls still being assembled when the stream ends
      // without an explicit finish_reason line.
      yield* assembler.flush();
    } finally {
      reader.releaseLock();
    }
  }

  private *handleSseLine(line: string, assembler: ToolCallAssembler): Generator<StreamEvent> {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      if (payload === "[DONE]") yield* assembler.flush();
      return;
    }

    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      return; // tolerate malformed keep-alive/comment payloads
    }

    if (chunk.error?.message) {
      throw new Error(chunk.error.message);
    }

    if (chunk.usage && typeof chunk.usage === "object") {
      yield { kind: "usage", usage: chunk.usage };
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta;
    if (delta?.content) {
      yield { kind: "text", text: delta.content };
    }
    if (delta?.tool_calls) {
      assembler.accept(delta.tool_calls);
    }
    if (choice.finish_reason) {
      yield* assembler.flush();
    }
  }
}

/** Reassembles incremental tool_calls deltas (indexed fragments) into
 * complete calls, emitted once their JSON arguments are whole. */
class ToolCallAssembler {
  private pending = new Map<number, { id: string; name: string; args: string }>();

  accept(deltas: StreamToolCallDelta[]): void {
    for (const d of deltas) {
      const slot = this.pending.get(d.index) ?? { id: "", name: "", args: "" };
      if (d.id) slot.id = d.id;
      if (d.function?.name) slot.name += d.function.name;
      if (d.function?.arguments) slot.args += d.function.arguments;
      this.pending.set(d.index, slot);
    }
  }

  *flush(): Generator<StreamEvent> {
    for (const [, call] of [...this.pending.entries()].sort(([a], [b]) => a - b)) {
      if (!call.id || !call.name) continue;
      yield { kind: "toolCall", id: call.id, name: call.name, args: call.args || "{}" };
    }
    this.pending.clear();
  }
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text.slice(0, 200);
  } catch {
    return "";
  }
}
