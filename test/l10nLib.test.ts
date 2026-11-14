import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addMissingEnglishKeys,
  applyTranslations,
  checkBundles,
  collectUsedKeys,
  hasProblems,
  placeholders,
} from "../scripts/l10n-lib.mjs";

type Files = Record<string, string | object>;

/** The text of a bundle exactly as the scripts write it. */
function bundleText(value: object): string {
  return JSON.stringify(value, null, 2) + "\n";
}

describe("l10n-lib", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "l10n-lib-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Writes `files` (relative path → text, or an object stored as a canonical bundle) under `dir`. */
  function write(files: Files, dir = root): void {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, typeof content === "string" ? content : bundleText(content));
    }
  }

  const read = (rel: string, dir = root): string => fs.readFileSync(path.join(dir, rel), "utf8");

  describe("collectUsedKeys", () => {
    it("finds literal keys in vscode.l10n.t, ctx.t and bare t calls", () => {
      write({
        "src/a.ts": [
          'import * as vscode from "vscode";',
          'export const a = vscode.l10n.t("Hello");',
          'export const b = ctx.t("World {0}", 1);',
          'export const c = t("Bare");',
          'export const d = this.t("This");',
          'export const e = deps.t("Deps");',
          'export const f = l10n.t("Short");',
          'export const g = vscode.l10n.t("Hello");',
        ].join("\n"),
        "src/sub/b.ts": 'export const h = t("Nested");\n',
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect([...keys.keys()].sort()).toEqual(
        ["Bare", "Deps", "Hello", "Nested", "Short", "This", "World {0}"].sort()
      );
      expect(keys.get("Hello")).toEqual([
        { file: "src/a.ts", line: 2 },
        { file: "src/a.ts", line: 8 },
      ]);
      expect(keys.get("Nested")).toEqual([{ file: "src/sub/b.ts", line: 1 }]);
      expect(dynamic).toEqual([]);
    });

    it("reads a template literal without substitutions and the object form's message", () => {
      write({
        "src/a.ts": [
          "export const a = t(`Plain template`);",
          'export const b = vscode.l10n.t({ message: "Object {0}", args: [1], comment: ["why"] });',
          "export const c = vscode.l10n.t({ message: `Object template`, comment: [] });",
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect([...keys.keys()].sort()).toEqual(
        ["Object template", "Object {0}", "Plain template"].sort()
      );
      expect(dynamic).toEqual([]);
    });

    it("reports a non-literal first argument as dynamic, with file and line", () => {
      write({
        "src/a.ts": [
          "const name = 'x';",
          "export const a = t(name);",
          'export const b = t("left " + name);',
          "export const c = t(`with ${name}`);",
          "export const d = vscode.l10n.t({ message: name });",
          "export const e = vscode.l10n.t({ comment: ['no message'] });",
          "export const f = (message: string, ...args: unknown[]) => vscode.l10n.t(message, ...args);",
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect(keys.size).toBe(0);
      expect(dynamic).toEqual([
        { file: "src/a.ts", line: 2, text: "name" },
        { file: "src/a.ts", line: 3, text: '"left " + name' },
        { file: "src/a.ts", line: 4, text: "`with ${name}`" },
        { file: "src/a.ts", line: 5, text: "{ message: name }" },
        { file: "src/a.ts", line: 6, text: "{ comment: ['no message'] }" },
        { file: "src/a.ts", line: 7, text: "message" },
      ]);
    });

    it("ignores calls to other functions and methods named differently", () => {
      write({
        "src/a.ts": [
          'export const a = format("No");',
          'export const b = foo.tt("No");',
          'export const c = l10n.test("No");',
          'export const d = translate("No");',
          'export const e = t.call(null, "No");',
          "export const f = t();",
          'export const g = x["t"]("No");',
          'export const h = "t(\\"No\\")"; // t("No") in a comment',
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect(keys.size).toBe(0);
      expect(dynamic).toEqual([]);
    });

    it("unwraps parentheses, as, satisfies, non-null and type assertions around the key", () => {
      write({
        "src/a.ts": [
          'export const a = t(("Parenthesised"));',
          'export const b = t("As const" as const);',
          'export const c = t("Satisfies" satisfies string);',
          'export const d = t("NonNull"!);',
          'export const e = t(<string>"Assertion");',
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect([...keys.keys()]).toEqual(["Parenthesised", "As const", "Satisfies", "NonNull", "Assertion"]);
      expect(keys.get("Assertion")).toEqual([{ file: "src/a.ts", line: 5 }]);
      expect(dynamic).toEqual([]);
    });

    it("takes the keys of both branches of a conditional, and flags a branch that is not a literal", () => {
      write({
        "src/a.ts": [
          'export const a = t(flag ? "Yes" : "No");',
          'export const b = t(first ? "X" : second ? "Y" : "Z");',
          'export const c = t(flag ? "Known" : other);',
          'export const d = vscode.l10n.t({ message: flag ? "Obj A" : "Obj B" });',
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect([...keys.keys()]).toEqual(["Yes", "No", "X", "Y", "Z", "Known", "Obj A", "Obj B"]);
      expect(keys.get("Z")).toEqual([{ file: "src/a.ts", line: 2 }]);
      expect(dynamic).toEqual([{ file: "src/a.ts", line: 3, text: "other" }]);
    });

    it("joins a concatenation of literals into one key", () => {
      write({
        "src/a.ts": [
          'export const a = t("left " + "right");',
          'export const b = t("one" + ("two" as const) + `three`);',
          "export const c = ctx.t(",
          '  "multi" + "line"',
          ");",
          'export const d = t("left " + name);',
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect([...keys.keys()]).toEqual(["left right", "onetwothree", "multiline"]);
      expect(keys.get("multiline")).toEqual([{ file: "src/a.ts", line: 4 }]);
      expect(dynamic).toEqual([{ file: "src/a.ts", line: 6, text: '"left " + name' }]);
    });

    it("matches the object form's message written as a quoted name", () => {
      write({
        "src/a.ts": [
          'export const a = vscode.l10n.t({ "message": "Quoted {0}", args: [1] });',
          "export const b = vscode.l10n.t({ 'message': 'Single quoted' });",
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect([...keys.keys()]).toEqual(["Quoted {0}", "Single quoted"]);
      expect(dynamic).toEqual([]);
    });

    it("finds optional calls and calls inside a template-literal expression", () => {
      write({
        "src/a.ts": [
          'export const a = t?.("Optional bare");',
          'export const b = ctx?.t("Optional member");',
          "export const c = `<b>${t(\"In template\")}</b>`;",
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect([...keys.keys()]).toEqual(["Optional bare", "Optional member", "In template"]);
      expect(dynamic).toEqual([]);
    });

    it("reports a reference to a localisation function that is not a call as dynamic", () => {
      write({
        "src/a.ts": [
          'export const tr = vscode.l10n.t;',
          "export const a = () => vscode.l10n.t;",
          "export const b = wrap(ctx.t.bind(ctx));",
          "export const c = { translate: deps.t };",
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect(keys.size).toBe(0);
      expect(dynamic).toEqual([
        { file: "src/a.ts", line: 1, text: "vscode.l10n.t" },
        { file: "src/a.ts", line: 2, text: "vscode.l10n.t" },
        { file: "src/a.ts", line: 3, text: "ctx.t" },
        { file: "src/a.ts", line: 4, text: "deps.t" },
      ]);
    });

    it("allows the shapes that inject the function under the name t: a t constant and a t property", () => {
      write({
        "src/a.ts": [
          "export function html() {",
          "  const t = vscode.l10n.t;",
          '  return t("Through the alias");',
          "}",
          "export const deps = { t: vscode.l10n.t, other: 1 };",
          'export const use = (d: { t: typeof vscode.l10n.t }) => d.t("Through the property");',
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect([...keys.keys()]).toEqual(["Through the alias", "Through the property"]);
      expect(dynamic).toEqual([]);
    });

    it("accepts the function passed as a call argument and a pure forwarder passed as an argument", () => {
      write({
        "src/a.ts": [
          "export const a = fetchUsage(url, apiKey, vscode.l10n.t);",
          "export const b = fetchUsage(url, ctx.t);",
          "export const c = run(t);",
          "export const d = priceLabel(model, (message, ...args) => vscode.l10n.t(message, ...args));",
          "export const e = priceLabel(model, (message) => ctx.t(message));",
          "export const f = priceLabel(model, function (message, ...args) {",
          "  return deps.t(message, ...args);",
          "});",
          "export const g = priceLabel(model, (a, b, ...rest) => t(a, b, ...rest));",
          'export const h = vscode.l10n.t("Literal next to the forwarders");',
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect([...keys.keys()]).toEqual(["Literal next to the forwarders"]);
      expect(dynamic).toEqual([]);
    });

    it("accepts a pure forwarder stored under the name t", () => {
      write({
        "src/a.ts": [
          "export const deps = { t: (message: string, ...args: unknown[]) => vscode.l10n.t(message, ...args) };",
          "const t = (message: string) => vscode.l10n.t(message);",
          'export const use = t("Through the named forwarder");',
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect([...keys.keys()]).toEqual(["Through the named forwarder"]);
      expect(dynamic).toEqual([]);
    });

    it("reports a wrapper that is not a pure forwarder as dynamic: it reorders, drops or adds an argument, or does more", () => {
      write({
        "src/a.ts": [
          "export const a = labels((first, second) => vscode.l10n.t(second, first));",
          "export const b = labels((message, ...args) => vscode.l10n.t(message));",
          "export const c = labels((message) => vscode.l10n.t(message, 1));",
          "export const d = labels((message, ...args) => {",
          "  log(message);",
          "  return vscode.l10n.t(message, ...args);",
          "});",
          "export const e = labels((message, ...args) => vscode.l10n.t(message, args));",
          "export const f = labels((message) => vscode.l10n.t(message.trim()));",
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect(keys.size).toBe(0);
      expect(dynamic).toEqual([
        { file: "src/a.ts", line: 1, text: "second" },
        { file: "src/a.ts", line: 2, text: "message" },
        { file: "src/a.ts", line: 3, text: "message" },
        { file: "src/a.ts", line: 6, text: "message" },
        { file: "src/a.ts", line: 8, text: "message" },
        { file: "src/a.ts", line: 9, text: "message.trim()" },
      ]);
    });

    it("reports an alias under another name as dynamic, because the key X would be invisible", () => {
      write({
        "src/a.ts": [
          "export const tr = vscode.l10n.t;",
          'export const use = tr("X");',
          "export const back = () => vscode.l10n.t;",
          "export const stored = { translate: vscode.l10n.t };",
          "export const forwarder = (message: string) => vscode.l10n.t(message);",
        ].join("\n"),
      });

      const { keys, dynamic } = collectUsedKeys(path.join(root, "src"));

      expect(keys.has("X")).toBe(false);
      expect(dynamic).toEqual([
        { file: "src/a.ts", line: 1, text: "vscode.l10n.t" },
        { file: "src/a.ts", line: 3, text: "vscode.l10n.t" },
        { file: "src/a.ts", line: 4, text: "vscode.l10n.t" },
        // A forwarder kept under another name is the same hidden alias.
        { file: "src/a.ts", line: 5, text: "message" },
      ]);
    });
  });

  describe("placeholders", () => {
    it("lists placeholders unique and sorted", () => {
      expect(placeholders("{1} of {0} {0}")).toEqual(["{0}", "{1}"]);
      expect(placeholders("{10} then {2}")).toEqual(["{2}", "{10}"]);
      expect(placeholders("none here {x} {}")).toEqual([]);
    });
  });

  describe("checkBundles", () => {
    it("reports a key used in src and missing from the English bundle", () => {
      write({
        "src/a.ts": 't("Known"); t("Unknown"); t("Different");\n',
        "l10n/bundle.l10n.json": { Known: "Known", Different: "Not the key" },
        "package.nls.json": {},
      });

      const report = checkBundles(root);

      expect(report.missingInEnglish).toEqual(["Unknown"]);
      expect(report.englishValueMismatch).toEqual(["Different"]);
      expect(hasProblems(report)).toBe(true);
    });

    it("reports a missing, an empty and a placeholder-mismatched translation per locale", () => {
      write({
        "src/a.ts": 't("A"); t("B {0}"); t("C"); t("D"); t("E"); t("F");\n',
        "l10n/bundle.l10n.json": {
          A: "A",
          "B {0}": "B {0}",
          C: "C",
          D: "D",
          E: "E",
          F: "F",
        },
        "l10n/bundle.l10n.de.json": {
          A: "",
          "B {0}": "B ohne Platzhalter",
          D: "   ",
          E: 5,
          F: "F-de",
        },
        "l10n/bundle.l10n.fr.json": {
          A: "A-fr",
          "B {0}": "B-fr {0}",
          C: "C-fr",
          D: "D-fr",
          E: "E-fr",
          F: "F-fr",
        },
        "package.nls.json": {},
        "package.nls.de.json": {},
        "package.nls.fr.json": {},
      });

      const report = checkBundles(root);

      expect(report.locales.de).toEqual({
        missing: ["C"],
        extra: [],
        empty: ["A", "D", "E"],
        placeholderMismatch: ["B {0}"],
      });
      expect(report.locales.fr).toEqual({
        missing: [],
        extra: [],
        empty: [],
        placeholderMismatch: [],
      });
      expect(hasProblems(report)).toBe(true);
    });

    it("reports a manifest key missing from a locale", () => {
      write({
        "src/a.ts": 't("A");\n',
        "l10n/bundle.l10n.json": { A: "A" },
        "l10n/bundle.l10n.de.json": { A: "A-de" },
        "l10n/bundle.l10n.es.json": { A: "A-es" },
        "package.nls.json": { "cfg.a": "a", "cfg.b": "b" },
        "package.nls.de.json": { "cfg.a": "a-de" },
        // `es` has no manifest file and `fr` has no bundle file: each is missing every key of the kind it lacks.
        "package.nls.fr.json": { "cfg.a": "a-fr", "cfg.b": "b-fr" },
      });

      const report = checkBundles(root);

      expect(Object.keys(report.locales).sort()).toEqual(["de", "es", "fr"]);
      expect(Object.keys(report.nls).sort()).toEqual(["de", "es", "fr"]);
      expect(report.nls.de).toEqual({ missing: ["cfg.b"], extra: [] });
      expect(report.nls.es).toEqual({ missing: ["cfg.a", "cfg.b"], extra: [] });
      expect(report.nls.fr).toEqual({ missing: [], extra: [] });
      expect(report.locales.fr.missing).toEqual(["A"]);
      expect(report.locales.de.missing).toEqual([]);
      expect(hasProblems(report)).toBe(true);
    });

    it("treats extra and unused keys as non-fatal", () => {
      write({
        "src/a.ts": 't("A"); t(dynamicKey);\n',
        "l10n/bundle.l10n.json": { A: "A", Unused: "Unused" },
        "l10n/bundle.l10n.de.json": { A: "A-de", Unused: "Unused-de", Stale: "" },
        "package.nls.json": { "cfg.a": "a" },
        "package.nls.de.json": { "cfg.a": "a-de", "cfg.old": "alt" },
      });

      const report = checkBundles(root);

      expect(report.unusedInEnglish).toEqual(["Unused"]);
      expect(report.dynamic).toEqual([{ file: "src/a.ts", line: 1, text: "dynamicKey" }]);
      expect(report.locales.de.extra).toEqual(["Stale"]);
      // A blank value of a key that is not in the English bundle is not a fatal problem.
      expect(report.locales.de.empty).toEqual([]);
      expect(report.nls.de.extra).toEqual(["cfg.old"]);
      expect(report.missingInEnglish).toEqual([]);
      expect(hasProblems(report)).toBe(false);
    });
  });

  describe("applyTranslations", () => {
    let translations: string;

    beforeEach(() => {
      translations = fs.mkdtempSync(path.join(os.tmpdir(), "l10n-translations-"));
    });

    afterEach(() => {
      fs.rmSync(translations, { recursive: true, force: true });
    });

    const baseFiles: Files = {
      "l10n/bundle.l10n.json": { A: "A", "B {0}": "B {0}", C: "C" },
      "l10n/bundle.l10n.de.json": { A: "A-de" },
      "l10n/bundle.l10n.fr.json": { A: "A-fr" },
      "package.nls.json": { k1: "k1", k2: "k2" },
      "package.nls.de.json": { k1: "k1-de" },
      "package.nls.fr.json": { k1: "k1-fr" },
    };

    it("appends new translations after the existing keys and leaves existing values alone", () => {
      write(baseFiles);
      write({
        "de.json": {
          // "A" is already translated with the same value: skipped without complaint.
          bundle: { A: "A-de", "B {0}": "B-de {0}" },
          nls: { k2: "k2-de" },
        },
      }, translations);

      const result = applyTranslations(root, translations);

      expect(result.errors).toEqual([]);
      expect(result.written).toEqual(["l10n/bundle.l10n.de.json", "package.nls.de.json"]);
      expect(read("l10n/bundle.l10n.de.json")).toBe(bundleText({ A: "A-de", "B {0}": "B-de {0}" }));
      expect(Object.keys(JSON.parse(read("package.nls.de.json")))).toEqual(["k1", "k2"]);
      expect(read("package.nls.de.json")).toBe(bundleText({ k1: "k1-de", k2: "k2-de" }));
      // A locale without a translations file is not touched.
      expect(read("l10n/bundle.l10n.fr.json")).toBe(bundleText({ A: "A-fr" }));
    });

    it("writes nothing when one file has an error", () => {
      write(baseFiles);
      const before = read("l10n/bundle.l10n.de.json");
      write({
        "de.json": { bundle: { C: "C-de" }, nls: { k2: "k2-de" } },
        "fr.json": { bundle: { "B {0}": "B-fr sans marqueur" } },
      }, translations);

      const result = applyTranslations(root, translations);

      expect(result.written).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("fr");
      expect(result.errors[0]).toContain("B {0}");
      expect(read("l10n/bundle.l10n.de.json")).toBe(before);
      expect(read("package.nls.de.json")).toBe(bundleText({ k1: "k1-de" }));
      expect(read("l10n/bundle.l10n.fr.json")).toBe(bundleText({ A: "A-fr" }));
    });

    it("refuses to overwrite an existing translation unless forced", () => {
      write(baseFiles);
      write({ "de.json": { bundle: { A: "A-neu", C: "C-de" } } }, translations);
      const before = read("l10n/bundle.l10n.de.json");

      const refused = applyTranslations(root, translations);

      expect(refused.written).toEqual([]);
      expect(refused.errors).toHaveLength(1);
      expect(refused.errors[0]).toContain("A");
      expect(read("l10n/bundle.l10n.de.json")).toBe(before);

      const forced = applyTranslations(root, translations, { force: true });

      expect(forced.errors).toEqual([]);
      expect(forced.written).toEqual(["l10n/bundle.l10n.de.json"]);
      // The overwritten key keeps its position; the new key goes last.
      expect(read("l10n/bundle.l10n.de.json")).toBe(bundleText({ A: "A-neu", C: "C-de" }));
    });

    it("reports an unknown locale, an unknown key and an empty translation", () => {
      write(baseFiles);
      write({
        "xx.json": { bundle: { A: "A-xx" } },
        "de.json": { bundle: { "Not an English key": "x", C: "  " }, nls: { nope: "x" } },
      }, translations);

      const result = applyTranslations(root, translations);

      expect(result.written).toEqual([]);
      const text = result.errors.join("\n");
      expect(text).toContain("xx");
      expect(text).toContain("Not an English key");
      expect(text).toContain("empty");
      expect(text).toContain("nope");
    });

    it("refuses a target file that is not in the canonical form instead of reformatting it", () => {
      write({ ...baseFiles, "l10n/bundle.l10n.de.json": '{"A":"A-de"}' });
      write({ "de.json": { bundle: { C: "C-de" } } }, translations);

      const result = applyTranslations(root, translations);

      expect(result.written).toEqual([]);
      expect(result.errors.join("\n")).toContain("bundle.l10n.de.json");
      expect(read("l10n/bundle.l10n.de.json")).toBe('{"A":"A-de"}');
    });

    it("accepts a translations file whose name differs from the locale only by case", () => {
      write(baseFiles);
      write({ "DE.json": { bundle: { C: "C-de" } } }, translations);

      const result = applyTranslations(root, translations);

      expect(result.errors).toEqual([]);
      expect(result.written).toEqual(["l10n/bundle.l10n.de.json"]);
      expect(read("l10n/bundle.l10n.de.json")).toBe(bundleText({ A: "A-de", C: "C-de" }));
    });

    it("rejects two translations files that map to the same locale", () => {
      write(baseFiles);
      const before = read("l10n/bundle.l10n.de.json");
      write({ "de.json": { bundle: { C: "C-de" } }, "De.json": { bundle: { "B {0}": "B-de {0}" } } }, translations);
      // On a case-insensitive file system the second name would overwrite the first.
      if (fs.readdirSync(translations).length < 2) return;

      const result = applyTranslations(root, translations);

      expect(result.written).toEqual([]);
      expect(result.errors.join("\n")).toMatch(/de\.json.*De\.json|De\.json.*de\.json/);
      expect(read("l10n/bundle.l10n.de.json")).toBe(before);
    });

    it("explains that locale ids are the lowercase suffix of the bundle file name", () => {
      write(baseFiles);
      write({ "pt-BR.json": { bundle: { C: "C-pt" } } }, translations);

      const result = applyTranslations(root, translations);

      expect(result.errors.join("\n")).toContain('unknown locale "pt-BR"');
      expect(result.errors.join("\n")).toContain("lowercase");
    });

    it("rejects an unexpected top-level key in a translations file", () => {
      write(baseFiles);
      const before = read("l10n/bundle.l10n.de.json");
      write({ "de.json": { bundel: { C: "C-de" }, bundle: { C: "C-de" } } }, translations);

      const result = applyTranslations(root, translations);

      expect(result.written).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('"bundel"');
      expect(read("l10n/bundle.l10n.de.json")).toBe(before);
    });

    it("reports a missing or empty translations directory", () => {
      write(baseFiles);

      const missing = applyTranslations(root, path.join(translations, "does-not-exist"));
      expect(missing.written).toEqual([]);
      expect(missing.errors.join("\n")).toContain("not a directory");

      const empty = applyTranslations(root, translations);
      expect(empty.written).toEqual([]);
      expect(empty.errors.join("\n")).toContain("no <locale>.json files");
    });

    it("leaves no temporary file behind", () => {
      write(baseFiles);
      write({ "de.json": { bundle: { C: "C-de" }, nls: { k2: "k2-de" } } }, translations);

      expect(applyTranslations(root, translations).errors).toEqual([]);

      expect(fs.readdirSync(path.join(root, "l10n")).filter((n) => !/^bundle\.l10n(\.[\w-]+)?\.json$/.test(n))).toEqual([]);
      expect(fs.readdirSync(root).filter((n) => !/^(l10n|package\.nls(\.[\w-]+)?\.json)$/.test(n))).toEqual([]);
    });

    it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
      "reports a failed write, leaves the bundles untouched and removes its temporary files",
      () => {
        write(baseFiles);
        write({ "de.json": { bundle: { C: "C-de" } }, "fr.json": { bundle: { C: "C-fr" } } }, translations);
        const bundleDir = path.join(root, "l10n");
        const before = read("l10n/bundle.l10n.de.json");
        // A read-only directory: the temporary file cannot be created next to the bundle.
        fs.chmodSync(bundleDir, 0o555);
        try {
          const result = applyTranslations(root, translations);

          expect(result.written).toEqual([]);
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.errors.join("\n")).toContain("bundle.l10n.");
        } finally {
          fs.chmodSync(bundleDir, 0o755);
        }
        expect(read("l10n/bundle.l10n.de.json")).toBe(before);
        expect(fs.readdirSync(bundleDir).filter((n) => n.includes("tmp"))).toEqual([]);
      }
    );
  });

  describe("addMissingEnglishKeys", () => {
    it("adds missing English keys with the key as the value", () => {
      write({
        "src/a.ts": 't("A"); t("B {0}"); t("A"); t(dynamicKey);\n',
        "l10n/bundle.l10n.json": { A: "A", Old: "Old" },
      });

      expect(addMissingEnglishKeys(root)).toEqual(["B {0}"]);
      expect(read("l10n/bundle.l10n.json")).toBe(bundleText({ A: "A", Old: "Old", "B {0}": "B {0}" }));

      // Idempotent: nothing left to add, file untouched.
      const before = read("l10n/bundle.l10n.json");
      expect(addMissingEnglishKeys(root)).toEqual([]);
      expect(read("l10n/bundle.l10n.json")).toBe(before);
    });
  });

  describe("command line", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));

    /** A throwaway repository: copies of the scripts, a link to the real node_modules, and `files`. */
    function makeRepo(files: Files): string {
      write(files);
      for (const name of ["l10n-lib.mjs", "l10n-check.mjs", "l10n-apply.mjs"]) {
        fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, "scripts", name), path.join(root, "scripts", name));
      }
      fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "junction");
      return root;
    }

    /** An English bundle of `keys` long keys, translated into `locales` locales by empty bundles. */
    function bigRepo(keys: number, locales: number): string {
      const english: Record<string, string> = {};
      for (let i = 0; i < keys; i++) {
        const key = `A fairly long English sentence number ${i} that nobody has translated yet`;
        english[key] = key;
      }
      const files: Files = { "src/a.ts": "export const a = 1;\n", "l10n/bundle.l10n.json": english, "package.nls.json": {} };
      for (let i = 0; i < locales; i++) {
        files[`l10n/bundle.l10n.l${i}.json`] = {};
        files[`package.nls.l${i}.json`] = {};
      }
      return makeRepo(files);
    }

    it("keeps a --json report larger than 64 KB whole when stdout is a pipe", () => {
      const repo = bigRepo(150, 12);

      const run = spawnSync(process.execPath, [path.join(repo, "scripts/l10n-check.mjs"), "--json"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });

      expect(run.stdout.length).toBeGreaterThan(64 * 1024);
      const report = JSON.parse(run.stdout);
      expect(report.locales.l11.missing).toHaveLength(150);
      expect(run.status).toBe(1);
    });

    it("keeps the text report whole when stdout is a pipe and the reader is slow", async () => {
      const repo = bigRepo(150, 12);

      const child = spawn(process.execPath, [path.join(repo, "scripts/l10n-check.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      // Do not read for a while: the process must still deliver everything it wrote.
      await new Promise((resolve) => setTimeout(resolve, 400));
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      const status = await new Promise<number | null>((resolve) => child.on("close", resolve));

      const text = Buffer.concat(chunks).toString("utf8");
      expect(text.length).toBeGreaterThan(64 * 1024);
      expect(text.trimEnd().split("\n").pop()).toMatch(/^l10n: \d+ problem\(s\)$/);
      expect(status).toBe(1);
    });
  });
});
