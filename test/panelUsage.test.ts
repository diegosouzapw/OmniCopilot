import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("usage panel reset times", () => {
  it("renders personal and provider reset timestamps", () => {
    const panelSource = readFileSync(join(process.cwd(), "src/panel.ts"), "utf8");

    expect(panelSource).toContain("reset(pers.dailyResetIn)");
    expect(panelSource).toContain("reset(pers.weeklyResetIn)");
    expect(panelSource).toContain("reset(q.resetIn)");
    expect(panelSource).toContain('S.usageResetsIn.replace("{0}", value)');
  });
});
