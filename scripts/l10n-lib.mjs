// Localisation tooling: finds every key the sources pass to `l10n.t`, compares them with the
// bundles, and merges translations into the bundles. Pure functions: no console output, no
// process exit. The command-line wrappers are l10n-check.mjs and l10n-apply.mjs.
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const ENGLISH_BUNDLE = "l10n/bundle.l10n.json";
const ENGLISH_NLS = "package.nls.json";
const BUNDLE_FILE = /^bundle\.l10n\.(.+)\.json$/;
const NLS_FILE = /^package\.nls\.(.+)\.json$/;

/** @param {object} o @param {string} k Own-property test: bundle keys are free text, so `"constructor" in obj` must not match. */
const has = (o, k) => Object.hasOwn(o, k);

/** @param {string} a @param {string} b */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @param {Iterable<string>} values */
const sorted = (values) => [...values].sort(byCodeUnit);

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join("/");

/**
 * @typedef {{ file: string, line: number }} KeyLocation
 * @typedef {{ file: string, line: number, text: string }} DynamicCall
 * @typedef {{ missing: string[], extra: string[], empty: string[], placeholderMismatch: string[] }} LocaleReport
 * @typedef {{
 *   missingInEnglish: string[],
 *   unusedInEnglish: string[],
 *   englishValueMismatch: string[],
 *   dynamic: DynamicCall[],
 *   locales: Record<string, LocaleReport>,
 *   nls: Record<string, { missing: string[], extra: string[] }>,
 * }} BundleReport
 */

/** @param {string} dir @returns {string[]} every `.ts`/`.tsx` file below `dir`, sorted. */
function listSourceFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort(byCodeUnit);
}

/** @param {ts.CallExpression} call True for `t(…)` and for `<anything>.t(…)`. */
function isLocalisationCall(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "t";
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "t";
}

/** @param {ts.Node} node The text of a string literal or of a template literal without substitutions, else undefined. */
function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

/** @param {ts.Node} node Whether `node` only wraps another expression without changing its value. */
const isWrapper = (node) =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isTypeAssertionExpression(node);

/** @param {ts.Expression} node Strips parentheses, `as`, `satisfies`, `!` and `<T>` wrappers. */
function unwrap(node) {
  let current = node;
  while (isWrapper(current)) current = current.expression;
  return current;
}

/**
 * The text of an expression made only of string literals joined with `+`, else undefined.
 * @param {ts.Expression} node
 * @returns {string | undefined}
 */
function staticText(node) {
  const inner = unwrap(node);
  const literal = literalText(inner);
  if (literal !== undefined) return literal;
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(inner.left);
    const right = left === undefined ? undefined : staticText(inner.right);
    return right === undefined ? undefined : left + right;
  }
  return undefined;
}

/**
 * The keys a localisation argument stands for. Each entry is `{ node, key }` for a statically
 * known key, or `{ node }` (no key) for an expression that cannot be resolved. A conditional gives
 * the entries of both branches; the object form gives those of its `message`.
 * @param {ts.Expression} arg
 * @param {ts.Node} [report] the node to point at when `arg` cannot be resolved
 * @returns {Array<{ node: ts.Node, key?: string }>}
 */
function keyEntries(arg, report = arg) {
  const node = unwrap(arg);
  const key = staticText(node);
  if (key !== undefined) return [{ node, key }];
  if (ts.isConditionalExpression(node)) return [...keyEntries(node.whenTrue), ...keyEntries(node.whenFalse)];
  if (ts.isObjectLiteralExpression(node)) {
    const message = node.properties.find(
      (prop) =>
        ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) && prop.name.text === "message"
    );
    if (message && ts.isPropertyAssignment(message)) return keyEntries(message.initializer, node);
  }
  return [{ node: report }];
}

/**
 * The detector recognises calls by the name `t`, so a reference to the localisation function is
 * only trustworthy when no call can hide under another name. A `<expr>.t` property access that is
 * not being called is therefore reported as dynamic, except in these shapes, where the keys are the
 * literal `t("…")` calls in the code that receives the function:
 *   - passed as an argument of a call: `fetchUsage(url, key, vscode.l10n.t)`;
 *   - stored under the name t: `const t = vscode.l10n.t;` and `{ t: vscode.l10n.t }`.
 * Anything else (`const tr = vscode.l10n.t`, `return vscode.l10n.t`, `{ translate: ctx.t }`,
 * `ctx.t.bind(ctx)`) is dynamic: write the string as a literal `t("…")` call.
 * @param {ts.PropertyAccessExpression} node a property access whose name is `t`
 */
function isStrayReference(node) {
  const outer = outermost(node);
  const parent = outer.parent;
  if (ts.isCallExpression(parent)) return false; // the callee, or an argument
  return !isStoredUnderT(outer);
}

/** @param {ts.Node} node `node` and the wrappers (parentheses, `as`, `!`, …) around it, outermost. */
function outermost(node) {
  let outer = node;
  while (outer.parent && isWrapper(outer.parent)) outer = outer.parent;
  return outer;
}

/** @param {ts.Node} outer Whether `outer` is the value of `const t = …` or of a property named `t`. */
function isStoredUnderT(outer) {
  const parent = outer.parent;
  const named = (name) => name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "t";
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer) return named(parent.name);
  if (ts.isPropertyAssignment(parent) && parent.initializer === outer) return named(parent.name);
  return false;
}

/**
 * The call inside a pure forwarder, else undefined. A forwarder is a function or arrow expression
 * whose whole body is one call to a localisation function that passes exactly its own parameters,
 * in order (a trailing rest parameter as a spread): `(message, ...args) => vscode.l10n.t(message,
 * ...args)`. That call forwards a key it does not know, so it is not a key use. A forwarder is
 * only accepted where a plain reference would be: as an argument of a call, or stored under the
 * name t. Under any other name it would hide the keys of its callers, like `const tr = vscode.l10n.t`.
 * @param {ts.Node} fn
 * @returns {ts.CallExpression | undefined}
 */
function forwardedCall(fn) {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined;
  const outer = outermost(fn);
  if (!(ts.isCallExpression(outer.parent) && outer.parent.arguments.includes(outer)) && !isStoredUnderT(outer)) return undefined;

  let body = fn.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return undefined;
    const [only] = body.statements;
    if (ts.isReturnStatement(only) && only.expression) body = only.expression;
    else if (ts.isExpressionStatement(only)) body = only.expression;
    else return undefined;
  }
  const call = unwrap(body);
  if (!ts.isCallExpression(call) || !isLocalisationCall(call)) return undefined;

  const { parameters } = fn;
  if (parameters.length === 0 || call.arguments.length !== parameters.length) return undefined;
  const forwards = parameters.every((param, i) => {
    if (!ts.isIdentifier(param.name) || param.initializer) return false;
    const arg = call.arguments[i];
    if (param.dotDotDotToken) return ts.isSpreadElement(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === param.name.text;
    return ts.isIdentifier(arg) && arg.text === param.name.text;
  });
  return forwards ? call : undefined;
}

/**
 * Every localisation key used in the TypeScript sources under `srcDir`.
 *
 * A localisation call is `t(…)` or `<expr>.t(…)` (optional calls included). Its first argument
 * gives the keys, after unwrapping parentheses and `as`/`satisfies`/`!`/`<T>`:
 *   - a string literal, a template literal without substitutions, or `"a" + "b"` of literals;
 *   - a conditional: the keys of both branches;
 *   - an object literal with such a `message` (identifier or quoted name).
 * Anything else is reported in `dynamic` with its source text, and so is a reference to the
 * function that is not a call or one of the injection shapes (see `isStrayReference`, and
 * `forwardedCall` for the pure forwarders that are not key uses). `file` is relative to the parent of
 * `srcDir` (the repository root), with forward slashes; `line` is the 1-based line of the key
 * (or, for a dynamic entry, of the expression).
 *
 * @param {string} srcDir
 * @returns {{ keys: Map<string, KeyLocation[]>, dynamic: DynamicCall[] }}
 */
export function collectUsedKeys(srcDir) {
  const base = path.dirname(path.resolve(srcDir));
  /** @type {Map<string, KeyLocation[]>} */
  const keys = new Map();
  /** @type {DynamicCall[]} */
  const dynamic = [];

  for (const full of listSourceFiles(srcDir)) {
    const file = toPosix(path.relative(base, full));
    const source = ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.ES2022, true);
    const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    /** @type {Set<ts.Node>} calls inside pure forwarders: they carry a key, they do not use one */
    const forwarded = new Set();

    const visit = (node) => {
      const inner = forwardedCall(node);
      if (inner) forwarded.add(inner);
      if (ts.isCallExpression(node) && isLocalisationCall(node) && node.arguments.length > 0 && !forwarded.has(node)) {
        for (const { node: at, key } of keyEntries(node.arguments[0])) {
          if (key !== undefined) {
            const locations = keys.get(key) ?? [];
            locations.push({ file, line: lineOf(at) });
            keys.set(key, locations);
          } else {
            dynamic.push({ file, line: lineOf(at), text: at.getText(source) });
          }
        }
      } else if (ts.isPropertyAccessExpression(node) && node.name.text === "t" && isStrayReference(node)) {
        dynamic.push({ file, line: lineOf(node), text: node.getText(source) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { keys, dynamic };
}

/**
 * The `{n}` placeholders of a string, unique and sorted: "{1} of {0} {0}" → ["{0}", "{1}"].
 * @param {string} text
 * @returns {string[]}
 */
export function placeholders(text) {
  const found = new Set([...text.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])));
  return [...found].sort((a, b) => a - b).map((n) => `{${n}}`);
}

/** @param {string} a @param {string} b */
const samePlaceholders = (a, b) => placeholders(a).join(",") === placeholders(b).join(",");

/** @param {unknown} value */
const isBlank = (value) => typeof value !== "string" || value.trim() === "";

/** @param {string} file @returns {Record<string, unknown>} */
function readJsonObject(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON object`);
  }
  return parsed;
}

/** @param {string} dir @param {RegExp} pattern @returns {Map<string, string>} locale → file path */
function localeFiles(dir, pattern) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const match = pattern.exec(name);
    if (match) out.set(match[1], path.join(dir, name));
  }
  return out;
}

/**
 * Compare sources, the English bundle, the locale bundles and the manifest bundles under `rootDir`.
 * @param {string} rootDir
 * @returns {BundleReport}
 */
export function checkBundles(rootDir) {
  const used = collectUsedKeys(path.join(rootDir, "src"));
  const english = readJsonObject(path.join(rootDir, ENGLISH_BUNDLE));
  const englishKeys = Object.keys(english);
  const englishNls = Object.keys(readJsonObject(path.join(rootDir, ENGLISH_NLS)));

  const bundles = localeFiles(path.join(rootDir, "l10n"), BUNDLE_FILE);
  const manifests = localeFiles(rootDir, NLS_FILE);
  const allLocales = sorted(new Set([...bundles.keys(), ...manifests.keys()]));

  /** @type {Record<string, LocaleReport>} */
  const locales = {};
  /** @type {Record<string, { missing: string[], extra: string[] }>} */
  const nls = {};

  for (const locale of allLocales) {
    const bundleFile = bundles.get(locale);
    if (bundleFile) {
      const bundle = readJsonObject(bundleFile);
      const keys = Object.keys(bundle);
      locales[locale] = {
        missing: sorted(englishKeys.filter((k) => !has(bundle, k))),
        extra: sorted(keys.filter((k) => !has(english, k))),
        empty: sorted(keys.filter((k) => has(english, k) && isBlank(bundle[k]))),
        placeholderMismatch: sorted(
          keys.filter((k) => has(english, k) && !isBlank(bundle[k]) && !samePlaceholders(k, /** @type {string} */ (bundle[k])))
        ),
      };
    } else {
      locales[locale] = { missing: sorted(englishKeys), extra: [], empty: [], placeholderMismatch: [] };
    }

    const manifestFile = manifests.get(locale);
    if (manifestFile) {
      const manifest = readJsonObject(manifestFile);
      nls[locale] = {
        missing: sorted(englishNls.filter((k) => !has(manifest, k))),
        extra: sorted(Object.keys(manifest).filter((k) => !englishNls.includes(k))),
      };
    } else {
      nls[locale] = { missing: sorted(englishNls), extra: [] };
    }
  }

  return {
    missingInEnglish: sorted([...used.keys.keys()].filter((k) => !has(english, k))),
    unusedInEnglish: sorted(englishKeys.filter((k) => !used.keys.has(k))),
    englishValueMismatch: sorted(englishKeys.filter((k) => english[k] !== k)),
    dynamic: used.dynamic,
    locales,
    nls,
  };
}

/**
 * True when the report has a fatal problem: a key missing from the English bundle, an English value
 * that differs from its key, or a locale with a missing, empty or placeholder-mismatched translation
 * or a missing manifest string. Unused keys, dynamic calls and extra keys are not fatal.
 * @param {BundleReport} report
 */
export function hasProblems(report) {
  if (report.missingInEnglish.length > 0 || report.englishValueMismatch.length > 0) return true;
  const badLocale = (r) => r.missing.length > 0 || r.empty.length > 0 || r.placeholderMismatch.length > 0;
  return Object.values(report.locales).some(badLocale) || Object.values(report.nls).some((r) => r.missing.length > 0);
}

/** @param {object} value */
const serialise = (value) => JSON.stringify(value, null, 2) + "\n";

/**
 * Validate and merge translations into the bundles. Each `<translationsDir>/<locale>.json` is
 * `{ "bundle"?: { "<English key>": "<translation>" }, "nls"?: { "<manifest key>": "<translation>" } }`.
 * New keys are appended after the existing ones; nothing is written when any file has an error.
 *
 * @param {string} rootDir
 * @param {string} translationsDir
 * @param {{ force?: boolean }} [options] `force` overwrites a different existing translation.
 * @returns {{ written: string[], errors: string[] }}
 */
export function applyTranslations(rootDir, translationsDir, { force = false } = {}) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, string>} absolute target path → new content */
  const pending = new Map();

  if (!fs.existsSync(translationsDir) || !fs.statSync(translationsDir).isDirectory()) {
    return { written: [], errors: [`${translationsDir}: not a directory`] };
  }
  const files = fs.readdirSync(translationsDir).filter((name) => name.endsWith(".json")).sort(byCodeUnit);
  if (files.length === 0) return { written: [], errors: [`${translationsDir}: no <locale>.json files found`] };

  const english = Object.keys(readJsonObject(path.join(rootDir, ENGLISH_BUNDLE)));
  const englishNls = Object.keys(readJsonObject(path.join(rootDir, ENGLISH_NLS)));
  const bundles = localeFiles(path.join(rootDir, "l10n"), BUNDLE_FILE);
  const manifests = localeFiles(rootDir, NLS_FILE);
  const knownLocales = sorted(new Set([...bundles.keys(), ...manifests.keys()]));
  /** @type {Map<string, string>} locale → the translations file that claimed it */
  const seenLocales = new Map();

  /**
   * Merge one section of a translations file into its target file.
   * @param {string} name translations file name, for messages
   * @param {string} section "bundle" or "nls"
   * @param {unknown} entries
   * @param {string | undefined} target absolute path of the file to merge into
   * @param {string} locale
   * @param {string[]} reference the English keys the section may translate
   * @param {boolean} checkPlaceholders
   */
  const merge = (name, section, entries, target, locale, reference, checkPlaceholders) => {
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
      errors.push(`${name}: "${section}" must be an object`);
      return;
    }
    if (!target) {
      errors.push(`${name}: unknown locale "${locale}" (no ${section === "bundle" ? "l10n bundle" : "package.nls"} file for it)`);
      return;
    }
    const before = fs.readFileSync(target, "utf8");
    const existing = readJsonObject(target);
    if (before !== serialise(existing)) {
      errors.push(`${name}: ${path.relative(rootDir, target)} is not in the canonical JSON form (2-space indent, trailing newline); refusing to reformat it`);
      return;
    }

    const problems = errors.length;
    const next = { ...existing };
    for (const [key, value] of Object.entries(entries)) {
      const label = `${name}: ${section} ${JSON.stringify(key)}`;
      if (!reference.includes(key)) {
        errors.push(`${label} is not a key of the English ${section === "bundle" ? "bundle" : "package.nls.json"}`);
      } else if (isBlank(value)) {
        errors.push(`${label} has an empty translation`);
      } else if (checkPlaceholders && !samePlaceholders(key, value)) {
        errors.push(`${label} has different placeholders from the English key (${placeholders(key).join(" ") || "none"})`);
      } else if (has(existing, key) && existing[key] !== value) {
        if (force) next[key] = value;
        else errors.push(`${label} already has a different translation; use --force to overwrite it`);
      } else if (!has(existing, key)) {
        next[key] = value;
      }
    }
    if (errors.length === problems) {
      const text = serialise(next);
      if (text !== before) pending.set(target, text);
    }
  };

  for (const name of files) {
    const locale = name.slice(0, -".json".length);
    let content;
    try {
      content = JSON.parse(fs.readFileSync(path.join(translationsDir, name), "utf8"));
    } catch (err) {
      errors.push(`${name}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (content === null || typeof content !== "object" || Array.isArray(content)) {
      errors.push(`${name}: expected a JSON object with "bundle" and/or "nls"`);
      continue;
    }
    const unknownSections = Object.keys(content).filter((k) => k !== "bundle" && k !== "nls");
    if (unknownSections.length > 0) {
      errors.push(`${name}: unexpected top-level key(s) ${unknownSections.map((k) => JSON.stringify(k)).join(", ")}`);
    }
    // The file name is matched to a known locale ignoring case: `pt-BR.json` is the `pt-br` locale.
    const known = knownLocales.find((l) => l.toLowerCase() === locale.toLowerCase());
    if (known === undefined) {
      errors.push(
        `${name}: unknown locale "${locale}" (no l10n bundle and no package.nls file for it; locale ids are the lowercase suffix of the bundle file name, such as pt-br or zh-cn)`
      );
      continue;
    }
    const earlier = seenLocales.get(known);
    if (earlier !== undefined) {
      errors.push(`${name}: maps to the same locale "${known}" as ${earlier}; keep one file per locale`);
      continue;
    }
    seenLocales.set(known, name);
    if ("bundle" in content) merge(name, "bundle", content.bundle, bundles.get(known), known, english, true);
    if ("nls" in content) merge(name, "nls", content.nls, manifests.get(known), known, englishNls, false);
  }

  if (errors.length > 0) return { written: [], errors };
  return writeAtomically(rootDir, pending);
}

/**
 * Write each `[path, text]` through a temporary file in the same directory, then rename it over the
 * original, so a failure never leaves a half-written bundle. Every temporary file is written before
 * the first rename; when that stage fails nothing has changed. A rename that fails midway reports
 * which files were already replaced.
 * @param {string} rootDir
 * @param {Map<string, string>} files absolute target path → new content
 * @returns {{ written: string[], errors: string[] }}
 */
function writeAtomically(rootDir, files) {
  const rel = (file) => toPosix(path.relative(rootDir, file));
  /** @type {Array<[string, string]>} temporary path, target path */
  const staged = [];
  const discard = (list) => list.forEach(([tmp]) => fs.rmSync(tmp, { force: true }));
  const reason = (err) => (err instanceof Error ? err.message : String(err));

  for (const [target, text] of files) {
    const tmp = `${target}.tmp-${process.pid}`;
    staged.push([tmp, target]);
    try {
      fs.writeFileSync(tmp, text);
    } catch (err) {
      discard(staged);
      return { written: [], errors: [`could not write ${rel(target)}: ${reason(err)}; nothing was changed`] };
    }
  }

  const written = [];
  for (const [index, [tmp, target]] of staged.entries()) {
    try {
      fs.renameSync(tmp, target);
      written.push(rel(target));
    } catch (err) {
      discard(staged.slice(index));
      const done = written.length > 0 ? `; already replaced: ${written.join(", ")}` : "";
      return { written: sorted(written), errors: [`could not replace ${rel(target)}: ${reason(err)}${done}`] };
    }
  }
  return { written: sorted(written), errors: [] };
}

/**
 * Add every key used in src and missing from the English bundle, with value = key.
 * @param {string} rootDir
 * @returns {string[]} the keys added, in order of first use
 */
export function addMissingEnglishKeys(rootDir) {
  const file = path.join(rootDir, ENGLISH_BUNDLE);
  const english = readJsonObject(file);
  const added = [...collectUsedKeys(path.join(rootDir, "src")).keys.keys()].filter((k) => !has(english, k));
  if (added.length > 0) {
    for (const key of added) english[key] = key;
    const { errors } = writeAtomically(rootDir, new Map([[file, serialise(english)]]));
    if (errors.length > 0) throw new Error(errors.join("\n"));
  }
  return added;
}
