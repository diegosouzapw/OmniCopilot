import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { OmniPanelProvider } from "../src/panel";

function panelCss(): string {
  const panel = new OmniPanelProvider(
    {} as vscode.ExtensionContext,
    {} as vscode.LogOutputChannel,
    async () => undefined
  );
  const html = (panel as unknown as { html(): string }).html();
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The rules whose selector list is exactly `selector`. */
function rulesFor(css: string, selector: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => sel.trim().replace(/\s+/g, " ") === selector)
    .map(([, , body]) => body);
}

/** Declarations of every rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string[] {
  return rulesFor(css, selector)
    .flatMap((body) => body.split(";"))
    .map((d) => d.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

describe("panel theme rules", () => {
  const css = panelCss();
  const hc = "body.vscode-high-contrast, body.vscode-high-contrast-light";

  it("gives buttons the theme's button border, and none to link buttons", () => {
    expect(rule(css, "button")).toContain("border: 1px solid var(--vscode-button-border, transparent)");
    expect(rule(css, "button.link")).toContain("border: none");
  });

  it("declares each link-button selector once", () => {
    expect(css).not.toContain("button.link, button.link:hover");
    expect(rulesFor(css, "button.link")).toHaveLength(1);
    expect(rulesFor(css, "button.link:hover")).toHaveLength(1);
    expect(rule(css, "button.link:hover")).toEqual(["background: transparent", "text-decoration: underline"]);
  });

  it("fills usage bars from their own variable: the accent in light and dark", () => {
    expect(rule(css, ".bar-fill")).toContain("background: var(--omni-bar)");
    expect(rule(css, "body")).toContain("--omni-bar: var(--omni-accent)");
  });

  it("falls back to colours every high-contrast theme defines", () => {
    const decls = rule(css, hc);
    expect(decls).toContain("--omni-bar: var(--vscode-progressBar-background, var(--vscode-foreground))");
    expect(decls).toContain("--omni-accent: var(--vscode-button-background, transparent)");
    expect(decls).toContain(
      "--omni-accent-fg: var(--vscode-button-foreground, var(--vscode-foreground))"
    );
  });

  it("keeps the secondary hover on a defined colour", () => {
    expect(rule(css, "button.secondary:hover")).toEqual([
      "background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground))",
    ]);
  });
});
