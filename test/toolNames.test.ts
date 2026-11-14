import { describe, expect, it } from "vitest";
import { MAX_TOOL_NAME_LENGTH, aliasToolName, createToolNameAliases } from "../src/toolNames";

const long = "mcp_" + "a".repeat(40) + "_" + "b".repeat(30); // 75 characters

describe("aliasToolName", () => {
  it("exposes the 64 character limit", () => {
    expect(MAX_TOOL_NAME_LENGTH).toBe(64);
  });

  it("leaves names of 64 characters or fewer untouched", () => {
    expect(aliasToolName("a".repeat(64))).toBe("a".repeat(64));
    expect(aliasToolName("run")).toBe("run");
  });

  it("shortens longer names to exactly 64 characters, deterministically", () => {
    const alias = aliasToolName(long);
    expect(alias).toHaveLength(64);
    expect(alias.startsWith(long.slice(0, 55) + "_")).toBe(true);
    expect(alias).toMatch(/_[0-9a-f]{8}$/);
    expect(aliasToolName(long)).toBe(alias);
  });

  it("gives different aliases to names that share their first 55 characters", () => {
    const a = "p".repeat(55) + "_first_tool";
    const b = "p".repeat(55) + "_second_tool";
    expect(aliasToolName(a)).not.toBe(aliasToolName(b));
  });

  it("honours a custom maximum length", () => {
    expect(aliasToolName("abcdefghijklmnopqrstuvwxyz", 20)).toHaveLength(20);
  });
});

describe("createToolNameAliases", () => {
  it("maps an alias back to the original name, and passes unknown names through", () => {
    const aliases = createToolNameAliases(["short", long]);
    const wire = aliases.toWire(long);
    expect(wire).toHaveLength(64);
    expect(aliases.fromWire(wire)).toBe(long);
    expect(aliases.toWire("short")).toBe("short");
    expect(aliases.fromWire("short")).toBe("short");
    expect(aliases.fromWire("never_registered")).toBe("never_registered");
  });

  it("aliases a name that was not registered up front", () => {
    const aliases = createToolNameAliases([]);
    expect(aliases.toWire(long)).toBe(aliasToolName(long));
  });
});
