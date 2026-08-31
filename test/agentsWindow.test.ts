import { describe, expect, it } from "vitest";
import {
  AGENT_HOST_SESSION_TYPE,
  AGENTS_WINDOW_ID_SUFFIX,
  expandForAgentsWindow,
} from "../src/agentsWindow";

interface Info {
  id: string;
  name: string;
  tooltip?: string;
  capabilities?: { toolCalling?: boolean; imageInput?: boolean };
  omniModelId: string;
}

const tools = (id: string, toolCalling: boolean): Info => ({
  id,
  name: id,
  tooltip: `OmniRoute · ${id}`,
  capabilities: { toolCalling, imageInput: false },
  omniModelId: id,
});

describe("expandForAgentsWindow", () => {
  it("returns the entries untouched when disabled", () => {
    const infos = [tools("glm-4.7", true), tools("small", false)];
    const out = expandForAgentsWindow(infos, false);
    expect(out).toEqual(infos);
    expect(out.some((e) => e.id.endsWith(AGENTS_WINDOW_ID_SUFFIX))).toBe(false);
  });

  it("adds one agent-host clone per tool-calling model when enabled", () => {
    const out = expandForAgentsWindow([tools("glm-4.7", true)], true);
    expect(out).toHaveLength(2);
    const clone = out[1];
    expect(clone.id).toBe(`glm-4.7${AGENTS_WINDOW_ID_SUFFIX}`);
    expect(clone.targetChatSessionType).toBe(AGENT_HOST_SESSION_TYPE);
  });

  it("never clones models without tool calling — agent sessions cannot use them", () => {
    const out = expandForAgentsWindow([tools("no-tools", false)], true);
    expect(out).toHaveLength(1);
    expect(out[0].targetChatSessionType).toBeUndefined();
  });

  it("treats a numeric toolCalling (max tool count) as tool support", () => {
    const numeric = { ...tools("counted", false), capabilities: { toolCalling: 128 } };
    const zero = { ...tools("zeroed", false), capabilities: { toolCalling: 0 } };
    const out = expandForAgentsWindow([numeric, zero], true);
    expect(out.map((e) => e.id)).toEqual(["counted", "zeroed", `counted${AGENTS_WINDOW_ID_SUFFIX}`]);
  });

  it("keeps the unscoped entries first and free of the session-type field", () => {
    const out = expandForAgentsWindow([tools("a", true), tools("b", true)], true);
    expect(out.map((e) => e.id)).toEqual(["a", "b", `a${AGENTS_WINDOW_ID_SUFFIX}`, `b${AGENTS_WINDOW_ID_SUFFIX}`]);
    expect(out[0].targetChatSessionType).toBeUndefined();
    expect(out[1].targetChatSessionType).toBeUndefined();
  });

  it("clones keep omniModelId and name so the chat path is unchanged", () => {
    const out = expandForAgentsWindow([tools("kimi-k3", true)], true);
    const clone = out[1];
    expect(clone.omniModelId).toBe("kimi-k3");
    expect(clone.name).toBe("kimi-k3");
  });

  it("marks the clone's tooltip so pickers stay distinguishable", () => {
    const withTooltip = expandForAgentsWindow([tools("m", true)], true)[1];
    expect(withTooltip.tooltip).toBe("OmniRoute · m · Agents window");
    const bare = expandForAgentsWindow([{ ...tools("m", true), tooltip: undefined }], true)[1];
    expect(bare.tooltip).toBe("Agents window");
  });

  it("handles an empty catalog", () => {
    expect(expandForAgentsWindow([], true)).toEqual([]);
  });
});
