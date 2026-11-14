import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { OmniPanelProvider, embeddedNextUrlFieldValue, nextUrlFieldValue } from "../src/panel";

const A = "https://a.example";
const B = "https://b.example";

const cases = [
  // The first status fills the empty field.
  { name: "first status", args: { current: "", lastReported: undefined, reported: A }, expected: A },
  // The field still holds what the host last reported: follow the new value.
  { name: "untouched field", args: { current: A, lastReported: A, reported: B }, expected: B },
  // The user typed: leave the field alone.
  {
    name: "edited field",
    args: { current: "https://typed.example", lastReported: A, reported: B },
    expected: "https://typed.example",
  },
];

describe("nextUrlFieldValue", () => {
  it.each(cases)("$name", ({ args, expected }) => {
    expect(nextUrlFieldValue(args)).toBe(expected);
  });

  it("keeps something typed before the first status arrived", () => {
    expect(nextUrlFieldValue({ current: "omni.lan", lastReported: undefined, reported: A })).toBe(
      "omni.lan"
    );
  });
});

describe("the panel script's copy of nextUrlFieldValue", () => {
  function panelHtml(): string {
    const panel = new OmniPanelProvider(
      {} as vscode.ExtensionContext,
      {} as vscode.LogOutputChannel,
      async () => undefined
    );
    return (panel as unknown as { html(): string }).html();
  }

  it("is embedded under a name the script chooses, not the one toString() prints", () => {
    expect(panelHtml()).toContain(`const nextUrlFieldValue = ${embeddedNextUrlFieldValue()};`);
  });

  it("stands alone and answers like the exported function", () => {
    // The script runs inside the webview, so its copy must not depend on anything
    // in this module. Evaluating the embedded source in a fresh VM context (no
    // access to the test's scope or the module) proves it.
    const embedded = runInNewContext(`(${embeddedNextUrlFieldValue()})`, {}) as typeof nextUrlFieldValue;
    for (const { args, expected } of cases) {
      expect(embedded(args)).toBe(expected);
      expect(embedded(args)).toBe(nextUrlFieldValue(args));
    }
  });
});
