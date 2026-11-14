// Checks that every string the sources localise is in the English bundle and that every English
// string and manifest string is translated in every locale.
//
//   node scripts/l10n-check.mjs          human-readable report
//   node scripts/l10n-check.mjs --json   the checkBundles report as JSON, nothing else on stdout
//
// Exit code 1 when there is a fatal problem (see hasProblems in l10n-lib.mjs), otherwise 0. The
// code is set with process.exitCode and the process ends by itself: process.exit() right after a
// write to a pipe would cut the output at the pipe's 64 KB buffer.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkBundles, hasProblems } from "./l10n-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const report = checkBundles(root);

process.exitCode = hasProblems(report) ? 1 : 0;

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  printReport();
}

function printReport() {
  /** @param {string} key Keys are printed one per line, so a newline inside one is shown escaped. */
  const show = (key) => key.replace(/\n/g, "\\n");

  const lines = [];
  let problems = 0;

  /** A section: a heading and its entries, only when there are entries. @param {string} title @param {string[]} entries */
  function section(title, entries) {
    if (entries.length === 0) return;
    lines.push(`${title} (${entries.length}):`, ...entries.map((e) => `  ${e}`), "");
  }

  /** One section per locale that has entries for `kind`. */
  function perLocale(title, source, kind) {
    const entries = Object.entries(source).filter(([, r]) => r[kind].length > 0);
    if (entries.length === 0) return 0;
    const total = entries.reduce((n, [, r]) => n + r[kind].length, 0);
    lines.push(`${title} (${total}):`);
    for (const [locale, r] of entries) lines.push(`  [${locale}] ${r[kind].length}`, ...r[kind].map((k) => `    ${show(k)}`));
    lines.push("");
    return total;
  }

  problems += report.missingInEnglish.length;
  section("Used in src but missing from l10n/bundle.l10n.json", report.missingInEnglish.map(show));
  problems += report.englishValueMismatch.length;
  section("English bundle value differs from its key", report.englishValueMismatch.map(show));
  problems += perLocale("Missing from locale bundles", report.locales, "missing");
  problems += perLocale("Empty translations in locale bundles", report.locales, "empty");
  problems += perLocale("Placeholders differ from the English key", report.locales, "placeholderMismatch");
  problems += perLocale("Missing from package.nls.<locale>.json", report.nls, "missing");

  // Findings that do not fail the check.
  const notes = [];
  const before = lines.length;
  section("In the English bundle but not used in src", report.unusedInEnglish.map(show));
  section("Localisation calls whose key is not a literal", report.dynamic.map((d) => `${d.file}:${d.line}  ${d.text}`));
  perLocale("In a locale bundle but not in the English bundle", report.locales, "extra");
  perLocale("In package.nls.<locale>.json but not in package.nls.json", report.nls, "extra");
  notes.push(...lines.splice(before));
  if (notes.length > 0) lines.push("note:", ...notes);

  const keyCount = Object.keys(JSON.parse(fs.readFileSync(path.join(root, "l10n/bundle.l10n.json"), "utf8"))).length;
  lines.push(problems === 0 ? `l10n: ok — ${keyCount} keys, ${Object.keys(report.locales).length} locales` : `l10n: ${problems} problem(s)`);

  process.stdout.write(lines.join("\n") + "\n");
}
