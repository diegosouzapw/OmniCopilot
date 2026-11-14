import { randomBytes } from "node:crypto";
import { isFramingAllowed } from "./embed";
import { parseRetryAfter, retryDelayFromMessage } from "./retry";
import type {
  ChatRequest,
  ModelsResponse,
  OmniRouteModel,
  StreamChunk,
  StreamErrorBody,
  StreamEvent,
  StreamToolCallDelta,
} from "./types";

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
}

const USER_AGENT = "OmniCopilot-VSCode";

/** The model catalog call gives up on its own after this long. */
const MODELS_TIMEOUT_MS = 15_000;

export interface RequestErrorInfo {
  /** HTTP status, from the response or from an error reported inside the stream. */
  status?: number;
  /** How long the server asked the caller to wait before trying again. */
  retryAfterMs?: number;
  /** The server could not be reached at all (no HTTP answer). */
  network?: boolean;
}

/** A request the server rejected or could not be reached for. `info` is what
 * the retry logic and the connection indicator need; the message is for people. */
export class OmniRouteRequestError extends Error {
  constructor(
    message: string,
    readonly info: RequestErrorInfo,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

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
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, MODELS_TIMEOUT_MS);
    const timeoutError = (cause: unknown) =>
      new OmniRouteRequestError(
        `OmniRoute /models did not answer within ${MODELS_TIMEOUT_MS / 1000} s`,
        { network: true },
        cause
      );

    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/models?prefix=alias`, {
          headers: headers(this.opts.apiKey, false),
          signal: ctrl.signal,
        });
      } catch (err) {
        throw timedOut ? timeoutError(err) : networkError(err);
      }
      if (!res.ok) {
        throw new OmniRouteRequestError(`OmniRoute /models returned HTTP ${res.status}`, {
          status: res.status,
        });
      }
      if (token?.isCancellationRequested) return [];
      let body: ModelsResponse;
      try {
        body = (await res.json()) as ModelsResponse;
      } catch (err) {
        if (timedOut) throw timeoutError(err);
        throw err;
      }
      return Array.isArray(body.data) ? body.data : [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /chat/completions with stream:true, yielding normalized events. */
  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: headers(this.opts.apiKey, true),
        body: JSON.stringify(request),
        signal,
      });
    } catch (err) {
      // A cancelled request keeps propagating as an abort; anything else means
      // the server could not be reached.
      if (signal.aborted || (err as { name?: string } | null)?.name === "AbortError") throw err;
      throw networkError(err);
    }

    if (!res.ok || !res.body) {
      const { detail, retryAfterMs } = await readErrorBody(res);
      throw new OmniRouteRequestError(
        `OmniRoute request failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
        {
          status: res.status,
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) ?? retryAfterMs,
        }
      );
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
      throw streamError(chunk.error, chunk.error.message);
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
      if (!call.name) continue;
      // Some servers never send an id; the editor needs one to pair the call
      // with its result, so make one up rather than dropping the call.
      const id = call.id || `call_${randomBytes(4).toString("hex")}`;
      yield { kind: "toolCall", id, name: call.name, args: call.args || "{}" };
    }
    this.pending.clear();
  }
}

/** Error message and retry hint from the JSON body of a rejected request. */
async function readErrorBody(res: Response): Promise<{ detail: string; retryAfterMs?: number }> {
  try {
    const text = await res.text();
    const { error } = JSON.parse(text) as { error?: StreamErrorBody };
    return {
      detail: error?.message ?? text.slice(0, 200),
      retryAfterMs: error && typeof error === "object" ? retryHint(error) : undefined,
    };
  } catch {
    return { detail: "" };
  }
}

/** Wait the server asks for in an error object: OmniRoute's `reset_seconds`,
 * the generic `retry_after_seconds`, or an ISO `retry_after` timestamp. */
function retryHint(error: StreamErrorBody): number | undefined {
  return (
    secondsToMs(error.reset_seconds) ??
    secondsToMs(error.retry_after_seconds) ??
    (typeof error.retry_after === "string" ? parseRetryAfter(error.retry_after) : undefined)
  );
}

function secondsToMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1000)
    : undefined;
}

/** An HTTP-looking status: a number, or digits in a string. A symbolic code
 * such as `model_cooldown` is not one. */
function asStatus(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

/** An error the server reported inside an otherwise healthy 200 stream. Its
 * HTTP-style status comes from the error object, else from the first `[503]`
 * in the message; the retry hint from the object, else from `(reset after 24s)`. */
function streamError(error: StreamErrorBody, message: string): OmniRouteRequestError {
  const inMessage = /\[(\d{3})\]/.exec(message);
  return new OmniRouteRequestError(message, {
    status:
      asStatus(error.status) ??
      asStatus(error.status_code) ??
      asStatus(error.code) ??
      (inMessage ? Number(inMessage[1]) : undefined),
    retryAfterMs: retryHint(error) ?? retryDelayFromMessage(message),
  });
}

/** `fetch` rejected without an HTTP answer. Node reports `TypeError: fetch
 * failed` and keeps the real reason (ECONNREFUSED, ENOTFOUND…) in `cause`. */
function networkError(err: unknown): OmniRouteRequestError {
  const reason = errorText(err);
  const cause = err instanceof Error ? errorText(err.cause) : "";
  const detail = [reason, cause].filter(Boolean).join(": ");
  return new OmniRouteRequestError(
    `OmniRoute request failed (network error)${detail ? `: ${detail}` : ""}`,
    { network: true },
    err
  );
}

function errorText(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0 && !err.message) {
    return errorText(err.errors[0]);
  }
  if (err instanceof Error) return err.message || (err as NodeJS.ErrnoException).code || "";
  return "";
}
