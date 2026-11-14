import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  estimateTokens,
  extractToolResultText,
  isEmptyContent,
  renderToolResult,
  toOpenAiMessages,
  toOpenAiTools,
} from "../src/convert";
import { normalizeBaseUrl, serverRootUrl } from "../src/client";

type AnyMessage = Parameters<typeof toOpenAiMessages>[0][number];

function msg(role: vscode.LanguageModelChatMessageRole, content: unknown[]): AnyMessage {
  return { role, content } as unknown as AnyMessage;
}

describe("toOpenAiMessages", () => {
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
      msg(vscode.LanguageModelChatMessageRole.System, [
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

function toolResultMessage(callId: string, content: unknown[]): AnyMessage {
  return msg(vscode.LanguageModelChatMessageRole.User, [
    new vscode.LanguageModelToolResultPart(callId, content),
  ]);
}

describe("tool-result content", () => {
  it("keeps tool-result image bytes out of the prompt text", () => {
    const img = new vscode.LanguageModelDataPart(new Uint8Array(100_000).fill(137), "image/png");
    const { text, images } = renderToolResult([new vscode.LanguageModelTextPart("ok"), img], {
      imageInput: false,
    });
    expect(text).toBe("ok[image omitted: image/png, 98 KB; this model does not accept images]");
    expect(images).toEqual([]);
  });

  it("attaches tool-result images after the tool message when the model accepts images", () => {
    const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
    const out = toOpenAiMessages([toolResultMessage("call_1", [img])], { imageInput: true });
    expect(out[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "[image: image/png, 3 B; attached after this result]",
    });
    expect(out[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Images returned by the tool call above:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ],
    });
    expect(out).toHaveLength(2);
  });

  it("puts collected images after the text and images the message already had", () => {
    const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
    const out = toOpenAiMessages(
      [
        msg(vscode.LanguageModelChatMessageRole.User, [
          new vscode.LanguageModelToolResultPart("call_1", [img]),
          new vscode.LanguageModelTextPart("and now?"),
        ]),
      ],
      { imageInput: true }
    );
    expect(out[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "and now?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ],
    });
  });

  describe("runs of tool results", () => {
    const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
    const imgPart = { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } };
    const label = { type: "text", text: "Images returned by the tool call above:" };
    const toolMsg = (id: string, text: string) => ({
      role: "tool",
      tool_call_id: id,
      content: text,
    });
    const imageNote = "[image: image/png, 3 B; attached after this result]";
    const roles = (out: Array<{ role: string }>) => out.map((m) => m.role);

    it("emits every tool message of one message before the image follow-up", () => {
      const out = toOpenAiMessages(
        [
          msg(vscode.LanguageModelChatMessageRole.User, [
            new vscode.LanguageModelToolResultPart("A", [img]),
            new vscode.LanguageModelToolResultPart("B", [new vscode.LanguageModelTextPart("b")]),
          ]),
        ],
        { imageInput: true }
      );
      expect(out).toEqual([
        toolMsg("A", imageNote),
        toolMsg("B", "b"),
        { role: "user", content: [label, imgPart] },
      ]);
    });

    it("keeps tool results from consecutive messages contiguous", () => {
      const out = toOpenAiMessages(
        [
          toolResultMessage("A", [img]),
          toolResultMessage("B", [new vscode.LanguageModelTextPart("b")]),
        ],
        { imageInput: true }
      );
      expect(out).toEqual([
        toolMsg("A", imageNote),
        toolMsg("B", "b"),
        { role: "user", content: [label, imgPart] },
      ]);
    });

    it("flushes the follow-up before the next message that has no tool result", () => {
      const out = toOpenAiMessages(
        [
          toolResultMessage("A", [img]),
          toolResultMessage("B", [new vscode.LanguageModelTextPart("b")]),
          msg(vscode.LanguageModelChatMessageRole.Assistant, [
            new vscode.LanguageModelTextPart("done"),
          ]),
        ],
        { imageInput: true }
      );
      expect(roles(out)).toEqual(["tool", "tool", "user", "assistant"]);
      expect(out[2]).toEqual({ role: "user", content: [label, imgPart] });
    });

    it("uses the text the messages carried instead of the caption", () => {
      const out = toOpenAiMessages(
        [
          msg(vscode.LanguageModelChatMessageRole.User, [
            new vscode.LanguageModelToolResultPart("A", [new vscode.LanguageModelTextPart("a")]),
            new vscode.LanguageModelTextPart("own text"),
          ]),
          toolResultMessage("B", [img]),
        ],
        { imageInput: true }
      );
      expect(out).toEqual([
        toolMsg("A", "a"),
        toolMsg("B", imageNote),
        { role: "user", content: [{ type: "text", text: "own text" }, imgPart] },
      ]);
    });

    it("gives each run its own follow-up", () => {
      const out = toOpenAiMessages(
        [
          toolResultMessage("A", [img]),
          msg(vscode.LanguageModelChatMessageRole.Assistant, [
            new vscode.LanguageModelToolCallPart("C", "t", {}),
          ]),
          toolResultMessage("C", [img]),
        ],
        { imageInput: true }
      );
      expect(roles(out)).toEqual(["tool", "user", "assistant", "tool", "user"]);
      expect(out[1]).toEqual({ role: "user", content: [label, imgPart] });
      expect(out[4]).toEqual({ role: "user", content: [label, imgPart] });
    });
  });

  it("omits tool-result images from the request when the model does not accept images", () => {
    const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
    const out = toOpenAiMessages([toolResultMessage("call_1", [img])]);
    expect(out).toEqual([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "[image omitted: image/png, 3 B; this model does not accept images]",
      },
    ]);
  });

  it("decodes JSON and text data parts, and replaces other binary data with a placeholder", () => {
    const enc = new TextEncoder();
    const parts = [
      new vscode.LanguageModelDataPart(enc.encode('{"a":1}'), "application/json"),
      new vscode.LanguageModelDataPart(enc.encode("plain"), "text/plain"),
      new vscode.LanguageModelDataPart(enc.encode('{"b":2}'), "application/vnd.api+json"),
      new vscode.LanguageModelDataPart(new Uint8Array(2048), "application/pdf"),
    ];
    expect(renderToolResult(parts, { imageInput: false }).text).toBe(
      '{"a":1}plain{"b":2}[binary data omitted: application/pdf, 2 KB]'
    );
  });

  it("ignores internal marker data parts", () => {
    const marker = new vscode.LanguageModelDataPart(new TextEncoder().encode("ephemeral"), "cache_control");
    expect(renderToolResult([marker], { imageInput: true })).toEqual({ text: "", images: [] });
  });

  it("stringifies structured value parts instead of printing [object Object]", () => {
    expect(renderToolResult([{ value: { a: 1 } }], { imageInput: false }).text).toBe('{"a":1}');
    expect(renderToolResult([{ value: "s" }, "t", { other: 1 }], { imageInput: false }).text).toBe(
      's' + 't' + '{"other":1}'
    );
  });

  it("extractToolResultText never attaches images", () => {
    const img = new vscode.LanguageModelDataPart(new Uint8Array([1]), "image/png");
    expect(extractToolResultText([img])).toBe(
      "[image omitted: image/png, 1 B; this model does not accept images]"
    );
  });
});

describe("estimateTokens for data parts", () => {
  const user = vscode.LanguageModelChatMessageRole.User;

  it("does not charge tokens for internal marker data parts", () => {
    const marker = new vscode.LanguageModelDataPart(new TextEncoder().encode("ephemeral"), "cache_control");
    expect(estimateTokens(msg(user, [marker]))).toBe(0);
  });

  it("still charges a flat 4000 tokens per image", () => {
    const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
    expect(estimateTokens(msg(user, [img]))).toBe(4000);
    expect(estimateTokens(msg(user, [toolResultPart(img)]))).toBe(4000 + Math.ceil("[image: image/png, 3 B; attached after this result]".length / 4));
  });

  it("charges readable text by length and other binary data nothing", () => {
    const text = new vscode.LanguageModelDataPart(new TextEncoder().encode("abcdefgh"), "text/plain");
    const bin = new vscode.LanguageModelDataPart(new Uint8Array(5000), "application/pdf");
    expect(estimateTokens(msg(user, [text]))).toBe(2);
    expect(estimateTokens(msg(user, [bin]))).toBe(0);
  });

  it("counts the rendered text of a tool result, not the serialized bytes", () => {
    const png = new vscode.LanguageModelDataPart(new Uint8Array(100_000).fill(137), "image/png");
    const n = estimateTokens(msg(user, [toolResultPart(new vscode.LanguageModelTextPart("ok"), png)]));
    expect(n).toBeLessThan(4100);
    expect(n).toBeGreaterThanOrEqual(4000);
  });
});

function toolResultPart(...content: unknown[]): vscode.LanguageModelToolResultPart {
  return new vscode.LanguageModelToolResultPart("call_1", content);
}

describe("tool-name aliasing in conversion", () => {
  it("aliases tool names in tools[] and in historical tool_calls[]", () => {
    const toWire = (n: string) => "x_" + n;
    const tools = toOpenAiTools([{ name: "run", description: "d", inputSchema: {} }], toWire);
    expect(tools?.[0].function.name).toBe("x_run");
    const out = toOpenAiMessages(
      [
        msg(vscode.LanguageModelChatMessageRole.Assistant, [
          new vscode.LanguageModelToolCallPart("call_1", "run", {}),
        ]),
      ],
      { toolName: toWire }
    );
    expect(out[0].tool_calls?.[0].function.name).toBe("x_run");
  });
});

describe("URL normalization", () => {
  it("appends /v1 and strips trailing slashes", () => {
    expect(normalizeBaseUrl("http://localhost:20128")).toBe("http://localhost:20128/v1");
    expect(normalizeBaseUrl("http://localhost:20128/")).toBe("http://localhost:20128/v1");
    expect(normalizeBaseUrl("http://localhost:20128/v1")).toBe("http://localhost:20128/v1");
  });

  it("adds http:// when the scheme is missing", () => {
    expect(normalizeBaseUrl("192.168.0.15:20128")).toBe("http://192.168.0.15:20128/v1");
  });

  it("falls back to the local default when empty", () => {
    expect(normalizeBaseUrl("")).toBe("http://localhost:20128/v1");
  });

  it("serverRootUrl strips the /v1 suffix", () => {
    expect(serverRootUrl("http://localhost:20128/v1")).toBe("http://localhost:20128");
    expect(serverRootUrl("myhost:1234")).toBe("http://myhost:1234");
  });
});
