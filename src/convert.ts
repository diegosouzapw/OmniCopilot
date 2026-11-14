import * as vscode from "vscode";
import type { ChatContentPart, ChatMessage, ChatTool } from "./types";

/**
 * Convert VS Code chat request messages to OpenAI Chat Completions messages.
 *
 * VS Code sends the FULL conversation history on every request. One VS Code
 * message can expand into several OpenAI messages (each tool result becomes
 * its own `role: "tool"` message).
 */
export interface ConvertOptions {
  /** Whether the target model accepts images. Images returned by tools are
   * attached to the request only when it does. Defaults to false. */
  imageInput?: boolean;
  /** Maps an editor-side tool name to the name sent on the wire. */
  toolName?: (name: string) => string;
}

export function toOpenAiMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: ConvertOptions = {}
): ChatMessage[] {
  const out: ChatMessage[] = [];
  const imageInput = options.imageInput === true;
  const toolName = options.toolName ?? ((name: string) => name);

  // A run of consecutive messages that carry tool results must stay contiguous
  // on the wire: every `tool` message directly follows the assistant message
  // whose calls it answers. What those messages carried besides results, and
  // the images the tools returned, wait here and go out as one `user` message
  // once the run ends.
  let pendingOwn: ChatContentPart[] = [];
  let pendingImages: ChatContentPart[] = [];
  const flushRun = () => {
    const followUp = withToolImages(pendingOwn, pendingImages);
    pendingOwn = [];
    pendingImages = [];
    if (!isEmptyContent(followUp)) out.push({ role: "user", content: followUp });
  };

  for (const msg of messages) {
    const parts = Array.isArray(msg.content) ? msg.content : [];

    const toolResults = parts.filter(
      (p): p is vscode.LanguageModelToolResultPart =>
        p instanceof vscode.LanguageModelToolResultPart
    );
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        const rendered = renderToolResult(result.content, { imageInput });
        pendingImages.push(...rendered.images);
        out.push({ role: "tool", content: rendered.text, tool_call_id: result.callId });
      }
      pendingOwn.push(...asContentParts(toContent(parts)));
      continue;
    }
    flushRun();

    if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
      const toolCalls = parts.filter(
        (p): p is vscode.LanguageModelToolCallPart =>
          p instanceof vscode.LanguageModelToolCallPart
      );
      if (toolCalls.length > 0) {
        const text = parts
          .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
          .map((p) => p.value)
          .join("");
        out.push({
          role: "assistant",
          // OpenAI expects null content when tool_calls are present and no text
          content: text || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.callId,
            type: "function" as const,
            function: {
              name: toolName(tc.name),
              arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}),
            },
          })),
        });
        continue;
      }
    }

    const content = toContent(msg.content);
    if (!isEmptyContent(content)) {
      out.push({ role: mapRole(msg.role), content });
    }
  }
  flushRun();

  return out;
}

function asContentParts(content: string | ChatContentPart[]): ChatContentPart[] {
  if (typeof content !== "string") return content;
  return content.trim() ? [{ type: "text", text: content }] : [];
}

/** What a run of tool-result messages carried besides the results, followed by
 * the images the tools returned. Without images that is the content alone (a
 * plain string when it is a single text); without other content a short
 * caption introduces the images. */
function withToolImages(
  own: ChatContentPart[],
  images: ChatContentPart[]
): string | ChatContentPart[] {
  if (images.length === 0) {
    return own.length === 1 && own[0].type === "text" ? own[0].text : own;
  }
  const lead: ChatContentPart[] = isEmptyContent(own)
    ? [{ type: "text", text: "Images returned by the tool call above:" }]
    : own;
  return [...lead, ...images];
}

function mapRole(role: vscode.LanguageModelChatMessageRole): "system" | "user" | "assistant" {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return "assistant";
  // Role 3 (System) is still proposed API — not in the stable enum, but the
  // editor may send it; map it defensively instead of downgrading to user.
  if ((role as number) === 3) return "system";
  return "user";
}

/** Text + images → string (single text) or OpenAI content-part array. */
function toContent(content: unknown): string | ChatContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: ChatContentPart[] = [];
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push({ type: "text", text: part.value });
    } else if (
      part instanceof vscode.LanguageModelDataPart &&
      typeof part.mimeType === "string" &&
      part.mimeType.startsWith("image/")
    ) {
      const base64 = Buffer.from(part.data).toString("base64");
      parts.push({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${base64}` } });
    }
  }

  // Plain string is the most compatible shape when there is no image.
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

export function isEmptyContent(content: string | ChatContentPart[] | null): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === "string") return content.trim().length === 0;
  if (content.length === 0) return true;
  return content.every((p) => p.type === "text" && p.text.trim().length === 0);
}

/** Tokens charged for each image, whatever its size (flat estimate). */
const TOKENS_PER_IMAGE = 4000;

function describeSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function normalizeMime(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase();
}

/** Internal markers (`cache_control`, `stateful_marker`, `usage`…) have no
 * `type/subtype` form: they steer the editor, not the model. */
function isMarkerMime(mimeType: string): boolean {
  return !mimeType.includes("/");
}

function isImageMime(mimeType: string): boolean {
  return normalizeMime(mimeType).startsWith("image/");
}

function isReadableMime(mimeType: string): boolean {
  const mime = normalizeMime(mimeType);
  return mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json");
}

function stringify(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

/**
 * Render the content of a tool result as prompt text, never as raw bytes.
 * Images are attached (returned in `images`) only when the model accepts them;
 * otherwise a placeholder says they were left out.
 */
export function renderToolResult(
  content: unknown,
  options: { imageInput: boolean }
): { text: string; images: ChatContentPart[] } {
  const images: ChatContentPart[] = [];
  const parts = Array.isArray(content) ? content : content === undefined || content === null ? [] : [content];

  const text = parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (part instanceof vscode.LanguageModelDataPart && typeof part.mimeType === "string") {
        if (isMarkerMime(part.mimeType)) return "";
        const size = describeSize(part.data.byteLength);
        if (isImageMime(part.mimeType)) {
          if (!options.imageInput) {
            return `[image omitted: ${part.mimeType}, ${size}; this model does not accept images]`;
          }
          const base64 = Buffer.from(part.data).toString("base64");
          images.push({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${base64}` } });
          return `[image: ${part.mimeType}, ${size}; attached after this result]`;
        }
        if (isReadableMime(part.mimeType)) return new TextDecoder().decode(part.data);
        return `[binary data omitted: ${part.mimeType}, ${size}]`;
      }
      if (part instanceof vscode.LanguageModelTextPart) return part.value;
      if (part && typeof part === "object" && "value" in part) {
        const value = (part as { value: unknown }).value;
        return typeof value === "string" ? value : stringify(value);
      }
      return stringify(part);
    })
    .join("");

  return { text, images };
}

/** Text of a tool result with no image attachments (see `renderToolResult`). */
export function extractToolResultText(content: unknown): string {
  return renderToolResult(content, { imageInput: false }).text;
}

export function toOpenAiTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  toolName: (name: string) => string = (name) => name
): ChatTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: toolName(t.name),
      description: t.description,
      parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    },
  }));
}

/** Cheap token estimate (chars/4) — the heuristic used by the official
 * sample and the Hugging Face provider. Must stay fast: VS Code calls it a lot. */
export function estimateTokens(text: string | vscode.LanguageModelChatRequestMessage): number {
  if (typeof text === "string") return Math.ceil(text.length / 4);

  const parts = Array.isArray(text.content) ? text.content : [];
  let chars = 0;
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      chars += part.value.length;
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      chars += part.name.length + JSON.stringify(part.input ?? {}).length;
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      const { text: rendered, images } = renderToolResult(part.content, { imageInput: true });
      chars += rendered.length + images.length * TOKENS_PER_IMAGE * 4;
    } else if (part instanceof vscode.LanguageModelDataPart && typeof part.mimeType === "string") {
      // Markers cost nothing; images a flat amount; readable text its length;
      // other binary data is never sent, so it costs nothing either.
      if (isImageMime(part.mimeType)) chars += TOKENS_PER_IMAGE * 4;
      else if (!isMarkerMime(part.mimeType) && isReadableMime(part.mimeType)) {
        chars += new TextDecoder().decode(part.data).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}
