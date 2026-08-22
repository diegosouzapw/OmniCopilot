import * as vscode from "vscode";
import { formatErrorValue } from "./client";
import type { ChatContentPart, ChatMessage, ChatTool } from "./types";

const MAX_SUMMARY_TOOL_NAMES = 8;
const MAX_SUMMARY_TOOL_NAME_LENGTH = 64;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
// Preserve underscores because they are conventional in tool identifiers;
// strip characters that can create Markdown structure or links.
const MARKDOWN_META = /[\\*`#[\]()<>!|~]/gu;

export function toolCallSummary(toolNames: readonly string[]): string {
  const safeNames: string[] = [];
  for (const rawName of toolNames) {
    const normalizedName = rawName
      .replace(CONTROL_OR_FORMAT, " ")
      .replace(MARKDOWN_META, "")
      .replace(/\s+/gu, " ")
      .trim();
    const safeName = Array.from(normalizedName).slice(0, MAX_SUMMARY_TOOL_NAME_LENGTH).join("") || "unnamed tool";
    if (safeName && !safeNames.includes(safeName)) safeNames.push(safeName);
    if (safeNames.length === MAX_SUMMARY_TOOL_NAMES) break;
  }
  return `Tools requested: ${safeNames.join(", ")}`;
}

/**
 * Convert VS Code chat request messages to OpenAI Chat Completions messages.
 *
 * VS Code sends the FULL conversation history on every request. One VS Code
 * message can expand into several OpenAI messages (each tool result becomes
 * its own `role: "tool"` message).
 */
export function toOpenAiMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    appendMessage(out, msg);
  }
  return reorderSystemMessages(out);
}

type ChatRequestParts = vscode.LanguageModelChatRequestMessage["content"];

/** Convert one VS Code request message into its OpenAI messages. */
function appendMessage(
  out: ChatMessage[],
  msg: vscode.LanguageModelChatRequestMessage
): void {
  const parts = Array.isArray(msg.content) ? msg.content : [];
  const { toolResults, toolCalls } = splitToolParts(parts);

  if (toolResults.length > 0) {
    appendToolResults(out, parts, toolResults);
    return;
  }

  if (msg.role === vscode.LanguageModelChatMessageRole.Assistant && toolCalls.length > 0) {
    out.push(buildAssistantMessage(parts, toolCalls));
    return;
  }

  const content = toContent(msg.content);
  if (!isEmptyContent(content)) {
    out.push({ role: mapRole(msg.role), content });
  }
}

/** Split message parts into tool result parts vs. tool call parts. */
function splitToolParts(parts: ChatRequestParts): {
  toolResults: vscode.LanguageModelToolResultPart[];
  toolCalls: vscode.LanguageModelToolCallPart[];
} {
  const toolResults: vscode.LanguageModelToolResultPart[] = [];
  const toolCalls: vscode.LanguageModelToolCallPart[] = [];
  for (const p of parts) {
    if (p instanceof vscode.LanguageModelToolResultPart) {
      toolResults.push(p);
    } else if (p instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push(p);
    }
  }
  return { toolResults, toolCalls };
}

/** One OpenAI `tool` message per result, plus a `user` message for the rest. */
function appendToolResults(
  out: ChatMessage[],
  parts: ChatRequestParts,
  toolResults: vscode.LanguageModelToolResultPart[]
): void {
  for (const result of toolResults) {
    out.push({
      role: "tool",
      content: extractToolResultText(result.content),
      tool_call_id: result.callId,
    });
  }
  const rest = toContent(parts);
  if (!isEmptyContent(rest)) out.push({ role: "user", content: rest });
}

/** Assistant message carrying tool calls, as OpenAI expects. */
function buildAssistantMessage(
  parts: ChatRequestParts,
  toolCalls: vscode.LanguageModelToolCallPart[]
): ChatMessage {
  const text = parts
    .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
    .map((p) => p.value)
    .join("");
  return {
    role: "assistant",
    // Preserve all visible assistant text, including a visible tool-request
    // summary from the prior turn. Whitespace alone is not meaningful content.
    content: text.trim().length > 0 ? text : null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.callId,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}),
      },
    })),
  };
}

/**
 * Some VS Code request histories place system instructions after the
 * conversation. Some upstream adapters also require one leading system
 * message, not several system entries interleaved with tool messages.
 */
function reorderSystemMessages(out: ChatMessage[]): ChatMessage[] {
  const system = out.filter((message) => message.role === "system");
  if (system.length === 0) return out;
  return [mergeSystemMessages(system), ...out.filter((message) => message.role !== "system")];
}

function mergeSystemMessages(system: ChatMessage[]): ChatMessage {
  const systemText: string[] = [];
  const systemParts: ChatContentPart[] = [];
  for (const message of system) {
    if (typeof message.content === "string") {
      systemText.push(message.content);
    } else if (Array.isArray(message.content)) {
      systemParts.push(...message.content);
    }
  }
  if (systemParts.length === 0) {
    return {
      role: "system",
      content: systemText.join("\n\n"),
    };
  }
  if (systemText.length > 0) {
    systemParts.unshift({ type: "text", text: systemText.join("\n\n") });
  }
  return {
    role: "system",
    content: systemParts,
  };
}

function mapRole(role: vscode.LanguageModelChatMessageRole): "system" | "user" | "assistant" {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return "assistant";
  // System is not in the stable VS Code enum, but some editor versions send
  // it at runtime as numeric 3 or the literal string "system".
  if ((role as unknown) === 3 || String(role).toLowerCase() === "system") return "system";
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

export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c instanceof vscode.LanguageModelTextPart) return c.value;
        if (c && typeof c === "object" && "value" in c) {
          const val = (c as Record<string, unknown>).value;
          // Objects must not fall through to String() (that would render the
          // useless "[object Object]"); keep null/undefined as an empty string.
          return val === undefined || val === null ? "" : formatErrorValue(val);
        }
        return typeof c === "string" ? c : JSON.stringify(c);
      })
      .join("");
  }
  return content === undefined || content === null ? "" : String(content);
}

export function toOpenAiTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): ChatTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
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
      chars += extractToolResultText(part.content).length;
    } else if (part instanceof vscode.LanguageModelDataPart) {
      chars += 4000 * 4; // flat estimate per image/binary attachment
    }
  }
  return Math.ceil(chars / 4);
}
