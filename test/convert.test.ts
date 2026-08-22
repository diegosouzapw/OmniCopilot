import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  estimateTokens,
  extractToolResultText,
  isEmptyContent,
  toOpenAiMessages,
  toOpenAiTools,
} from "../src/convert";
import { normalizeBaseUrl, serverRootUrl } from "../src/client";

type AnyMessage = Parameters<typeof toOpenAiMessages>[0][number];

const SystemRole = 3 as vscode.LanguageModelChatMessageRole;

function msg(role: vscode.LanguageModelChatMessageRole, content: unknown[]): AnyMessage {
  return { role, content } as unknown as AnyMessage;
}

describe("toOpenAiMessages", () => {
  it("moves system messages to the beginning of the request", () => {
    const out = toOpenAiMessages([
      msg(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("hello")]),
      msg(SystemRole, [new vscode.LanguageModelTextPart("rules")]),
      msg(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelTextPart("reply")]),
    ]);

    expect(out.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
  });

  it("converts a plain user text message to a string content", () => {
    const out = toOpenAiMessages([
      msg(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelTextPart("hello"),
      ]),
    ]);
    expect(out).toEqual([{ role: "user", content: "hello" }]);
  });

  it("maps roles including system", () => {
    const out = toOpenAiMessages([
      msg(SystemRole, [
        new vscode.LanguageModelTextPart("be brief"),
      ]),
      msg(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelTextPart("ok"),
      ]),
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "assistant"]);
  });

  it("drops empty messages", () => {
    const out = toOpenAiMessages([
      msg(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("  ")]),
    ]);
    expect(out).toEqual([]);
  });

  it("converts assistant tool calls with null content when there is no text", () => {
    const out = toOpenAiMessages([
      msg(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart("call_1", "read_file", { path: "a.ts" }),
      ]),
    ]);
    expect(out).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
    ]);
  });

  it("preserves assistant text that exactly matches a visible tool summary", () => {
    const out = toOpenAiMessages([
      msg(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart("call_1", "read_file", { path: "a.ts" }),
        new vscode.LanguageModelTextPart("Tools requested: read_file"),
      ]),
    ]);

    expect(out).toEqual([
      {
        role: "assistant",
        content: "Tools requested: read_file",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
    ]);
  });

  it("normalizes whitespace-only assistant text beside tool calls to null", () => {
    const out = toOpenAiMessages([
      msg(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart("call_1", "read_file", {}),
        new vscode.LanguageModelTextPart(" \t"),
        new vscode.LanguageModelTextPart("\r\n  "),
      ]),
    ]);

    expect(out[0].content).toBeNull();
    expect(out[0].tool_calls?.[0].function.name).toBe("read_file");
  });

  it("expands tool results into role:tool messages keeping callId", () => {
    const out = toOpenAiMessages([
      msg(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelToolResultPart("call_1", [
          new vscode.LanguageModelTextPart("file contents"),
        ]),
      ]),
    ]);
    expect(out).toEqual([
      { role: "tool", content: "file contents", tool_call_id: "call_1" },
    ]);
  });

  it("converts image data parts into data URLs", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = toOpenAiMessages([
      msg(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelTextPart("what is this?"),
        vscode.LanguageModelDataPart.image(bytes, "image/png"),
      ]),
    ]);
    expect(Array.isArray(out[0].content)).toBe(true);
    const parts = out[0].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[0]).toEqual({ type: "text", text: "what is this?" });
    expect(parts[1].type).toBe("image_url");
    expect(parts[1].image_url?.url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
  });

  it("merges mixed text and image system messages without dropping text", () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const out = toOpenAiMessages([
      msg(SystemRole, [
        new vscode.LanguageModelTextPart("System prompt instructions"),
      ]),
      msg(SystemRole, [
        vscode.LanguageModelDataPart.image(bytes, "image/jpeg"),
      ]),
      msg(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelTextPart("Hello"),
      ]),
    ]);

    expect(out[0].role).toBe("system");
    expect(Array.isArray(out[0].content)).toBe(true);
    const systemParts = out[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(systemParts[0]).toEqual({ type: "text", text: "System prompt instructions" });
    expect(systemParts[1].type).toBe("image_url");
    expect(systemParts[1].image_url?.url).toBe(`data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`);
  });
});

describe("toOpenAiTools", () => {
  it("returns undefined without tools", () => {
    expect(toOpenAiTools(undefined)).toBeUndefined();
    expect(toOpenAiTools([])).toBeUndefined();
  });

  it("maps tools and defaults missing schemas to an empty object schema", () => {
    const out = toOpenAiTools([
      { name: "run", description: "runs", inputSchema: { type: "object" } },
      { name: "bare", description: "no schema" } as never,
    ]);
    expect(out).toEqual([
      { type: "function", function: { name: "run", description: "runs", parameters: { type: "object" } } },
      {
        type: "function",
        function: { name: "bare", description: "no schema", parameters: { type: "object", properties: {} } },
      },
    ]);
  });
});

describe("helpers", () => {
  it("isEmptyContent", () => {
    expect(isEmptyContent("")).toBe(true);
    expect(isEmptyContent("  ")).toBe(true);
    expect(isEmptyContent("x")).toBe(false);
    expect(isEmptyContent([])).toBe(true);
    expect(isEmptyContent(null)).toBe(true);
  });

  it("extractToolResultText flattens mixed arrays", () => {
    expect(
      extractToolResultText([new vscode.LanguageModelTextPart("a"), "b", { value: "c" }])
    ).toBe("abc");
  });

  it("estimateTokens uses chars/4 for strings", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("URL normalization", () => {
  it("appends /v1 and strips trailing slashes", () => {
    expect(normalizeBaseUrl("http://localhost:20128")).toBe("http://127.0.0.1:20128/v1");
    expect(normalizeBaseUrl("http://localhost:20128/")).toBe("http://127.0.0.1:20128/v1");
    expect(normalizeBaseUrl("http://localhost:20128/v1")).toBe("http://127.0.0.1:20128/v1");
  });

  it("adds http:// when the scheme is missing", () => {
    expect(normalizeBaseUrl("192.168.0.15:20128")).toBe("http://192.168.0.15:20128/v1");
  });

  it("falls back to the local default when empty", () => {
    expect(normalizeBaseUrl("")).toBe("http://127.0.0.1:20128/v1");
  });

  it("serverRootUrl strips the /v1 suffix", () => {
    expect(serverRootUrl("http://localhost:20128/v1")).toBe("http://127.0.0.1:20128");
    expect(serverRootUrl("myhost:1234")).toBe("http://myhost:1234");
  });
});
