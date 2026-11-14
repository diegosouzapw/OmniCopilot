// Edits the localisation bundles.
//
//   node scripts/l10n-apply.mjs --english                     add the keys used in src to the English bundle
//   node scripts/l10n-apply.mjs <translationsDir> [--force]   merge <translationsDir>/<locale>.json into the bundles
//
// Each translations file is { "bundle"?: { "<English key>": "<translation>" }, "nls"?: { "<manifest key>": "<translation>" } }.
// Nothing is written when any file has an error. Exit code 1 on errors, set with process.exitCode
// (never process.exit(), which can cut output written to a pipe).
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { addMissingEnglishKeys, applyTranslations } from "./l10n-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));
const usage = "usage: node scripts/l10n-apply.mjs --english | <translationsDir> [--force]";

const list = (items) => items.map((item) => `  ${item}`).join("\n");

if (flags.includes("--english")) {
  const added = addMissingEnglishKeys(root);
  process.stdout.write(
    added.length > 0
      ? `Added ${added.length} key(s) to l10n/bundle.l10n.json:\n${list(added)}\n`
      : "Nothing to add: every key used in src is already in l10n/bundle.l10n.json.\n"
  );
} else if (positional.length === 1 && flags.every((f) => f === "--force")) {
  const { written, errors } = applyTranslations(root, path.resolve(positional[0]), { force: flags.includes("--force") });
  if (errors.length > 0) {
    process.stderr.write(`${errors.length} error(s):\n${list(errors)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      written.length > 0
        ? `Wrote ${written.length} file(s):\n${list(written)}\n`
        : "Nothing to write: every translation is already in the bundles.\n"
    );
  }
} else {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 1;
}
