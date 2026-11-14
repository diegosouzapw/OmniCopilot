import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { checkBundles } from "../scripts/l10n-lib.mjs";

// Parity guard on the real repository: what the sources use is in the English bundle, and every
// English string and manifest string is translated in all 41 locales. Run `node scripts/l10n-check.mjs`
// for the full list; fill the gaps with `node scripts/l10n-apply.mjs`.
const root = fileURLToPath(new URL("..", import.meta.url));
const report = checkBundles(root);

const LOCALES = 41;

/** One line per locale that has entries for `kind`, naming the keys. */
function describeLocales(
  kind: "missing" | "empty" | "placeholderMismatch",
  source: Record<string, Record<string, string[]>> = report.locales
): string {
  return Object.entries(source)
    .filter(([, entry]) => entry[kind].length > 0)
    .map(([locale, entry]) => `\n  [${locale}] ${kind}: ${entry[kind].map((k) => JSON.stringify(k)).join(", ")}`)
    .join("");
}

describe("l10n parity on the repository", () => {
  it("has every string used in src in the English bundle", () => {
    expect(
      report.missingInEnglish,
      `used in src but absent from l10n/bundle.l10n.json (add them with the key as the value): ${report.missingInEnglish
        .map((k) => JSON.stringify(k))
        .join(", ")}`
    ).toEqual([]);
    expect(
      report.englishValueMismatch,
      `English bundle values that differ from their key: ${report.englishValueMismatch
        .map((k) => JSON.stringify(k))
        .join(", ")}`
    ).toEqual([]);
  });

  it("translates every English string in all 41 locales with the same placeholders", () => {
    expect(Object.keys(report.locales)).toHaveLength(LOCALES);
    expect(describeLocales("missing"), "strings missing from locale bundles").toBe("");
    expect(describeLocales("empty"), "empty translations in locale bundles").toBe("");
    expect(
      describeLocales("placeholderMismatch"),
      "translations whose {n} placeholders differ from the English key"
    ).toBe("");
  });

  it("keeps package.nls locales in step with package.nls.json", () => {
    expect(Object.keys(report.nls)).toHaveLength(LOCALES);
    expect(describeLocales("missing", report.nls), "manifest strings missing from package.nls.<locale>.json").toBe("");
  });

  it("uses only literal keys, so every string can be checked", () => {
    expect(
      report.dynamic.map((d) => `${d.file}:${d.line}  ${d.text}`),
      "localisation calls (or references to the function) whose key is not a literal; write the English text as a literal so it can be translated"
    ).toEqual([]);
  });
});
