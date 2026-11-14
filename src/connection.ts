import * as vscode from "vscode";
import { DEFAULT_BASE_URL, normalizeBaseUrl, serverRootUrl } from "./client";
import { explainProbeFailure, type ProbeResult } from "./diagnostics";

/** SecretStorage entry holding the API key. */
export const SECRET_API_KEY = "omnicopilot.apiKey";
/** SecretStorage entry holding the origins the user approved for the stored key,
 * as a JSON array, newest last. It lives next to the key so that it travels
 * with it to every window, remote host and profile that can read the key. */
export const SECRET_API_KEY_ORIGINS = "omnicopilot.apiKeyOrigins";
/** How many approved origins are kept; the oldest is dropped first. */
const MAX_APPROVED_ORIGINS = 5;
/** globalState entry listing the plain-HTTP origins the user was already warned about. */
const STATE_INSECURE_WARNED = "omnicopilot.insecureOriginsWarned";
/** workspaceState entry holding the ignored workspace URL the user was last told about. */
const STATE_IGNORED_URL_NOTICE = "omnicopilot.ignoredUrlNotice";

export interface Connection {
  /** Normalized API base URL (always ends in `/v1`). */
  baseUrl: string;
  /** Scheme + host + port of `baseUrl`. */
  origin: string;
  /** The key to send. Undefined when none is stored or when it is withheld. */
  apiKey?: string;
  hasStoredKey: boolean;
  /** A key is stored but was saved for another origin, so it is not sent. */
  keyWithheld: boolean;
  /** Origins the user approved for the stored key, newest last. */
  approvedOrigins: string[];
  /** A server URL this workspace's settings set and that is not used (see `ignoredWorkspaceUrl`). */
  ignoredWorkspaceUrl: string | undefined;
}

/** Scheme, lower-case host and port of a base URL, without any path. */
export function originOf(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    return new URL(normalized).origin;
  } catch {
    return normalized.replace(/\/v1$/i, "").toLowerCase();
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "[::1]") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return octets !== null && octets.slice(1).every((part) => Number(part) <= 255);
}

/**
 * The key goes only to the origins the user approved for it. A key from before
 * 1.4.0 (no list at all) is adopted by the current origin; after that, a changed
 * URL keeps the key at home until the user approves it on purpose.
 */
export function decideKeyUse(args: {
  storedKey?: string;
  approvedOrigins?: readonly string[];
  currentOrigin: string;
}): { apiKey?: string; keyWithheld: boolean; bindNow: boolean } {
  const { storedKey, approvedOrigins, currentOrigin } = args;
  if (!storedKey) return { apiKey: undefined, keyWithheld: false, bindNow: false };
  if (approvedOrigins === undefined) {
    return { apiKey: storedKey, keyWithheld: false, bindNow: true };
  }
  if (approvedOrigins.includes(currentOrigin)) {
    return { apiKey: storedKey, keyWithheld: false, bindNow: false };
  }
  return { apiKey: undefined, keyWithheld: true, bindNow: false };
}

/**
 * The stored list of approved origins. Undefined only when nothing is stored (a
 * key from before 1.4.0); anything unreadable is an empty list, so a damaged
 * value withholds the key instead of letting any origin adopt it.
 */
export function parseApprovedOrigins(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function readApprovedOrigins(
  context: vscode.ExtensionContext
): Promise<string[] | undefined> {
  return parseApprovedOrigins(await context.secrets.get(SECRET_API_KEY_ORIGINS));
}

async function writeApprovedOrigins(
  context: vscode.ExtensionContext,
  origins: readonly string[]
): Promise<void> {
  await context.secrets.store(SECRET_API_KEY_ORIGINS, JSON.stringify(origins));
}

/** The fields of `inspect("baseUrl")` the server URL may come from. */
interface InspectedUrl {
  globalValue?: unknown;
  defaultValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/**
 * The server URL as the user set it: the user-level value (in a remote window VS
 * Code merges the remote machine's settings into it), else the declared default,
 * else the built-in one. Workspace, folder and language-specific values are never
 * read, so a repository cannot point the extension, and the key, elsewhere.
 */
export function userLevelBaseUrl(inspected: InspectedUrl | undefined): string {
  for (const value of [inspected?.globalValue, inspected?.defaultValue]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return DEFAULT_BASE_URL;
}

/**
 * The URL a workspace's settings set but that is not used: the folder value, else
 * the workspace value (the one VS Code would have applied), when it is a
 * non-empty string whose root differs from the effective one.
 */
export function ignoredWorkspaceUrl(args: {
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
  effectiveRoot: string;
}): string | undefined {
  const candidate = [args.workspaceFolderValue, args.workspaceValue].find(
    (value): value is string => typeof value === "string" && value.trim() !== ""
  );
  if (candidate === undefined) return undefined;
  return serverRootUrl(candidate) === args.effectiveRoot ? undefined : candidate.trim();
}

/** The only read of the `omnicopilot.baseUrl` setting. */
function readUrlSetting(): { baseUrl: string; ignoredWorkspaceUrl: string | undefined } {
  const inspected = vscode.workspace
    .getConfiguration("omnicopilot")
    .inspect<string>("baseUrl") as InspectedUrl | undefined;
  const baseUrl = normalizeBaseUrl(userLevelBaseUrl(inspected));
  return {
    baseUrl,
    ignoredWorkspaceUrl: ignoredWorkspaceUrl({
      workspaceValue: inspected?.workspaceValue,
      workspaceFolderValue: inspected?.workspaceFolderValue,
      effectiveRoot: serverRootUrl(baseUrl),
    }),
  };
}

function configuredBaseUrl(): string {
  return readUrlSetting().baseUrl;
}

/** The one place that resolves the server URL and the stored API key. */
export async function resolveConnection(context: vscode.ExtensionContext): Promise<Connection> {
  const setting = readUrlSetting();
  const baseUrl = setting.baseUrl;
  const origin = originOf(baseUrl);
  const storedKey = (await context.secrets.get(SECRET_API_KEY)) || undefined;
  const approvedOrigins = await readApprovedOrigins(context);

  const decision = decideKeyUse({ storedKey, approvedOrigins, currentOrigin: origin });
  if (decision.bindNow) {
    await writeApprovedOrigins(context, [origin]);
    await warnIfInsecure(context, origin);
  }
  return {
    baseUrl,
    origin,
    apiKey: decision.apiKey,
    hasStoredKey: Boolean(storedKey),
    keyWithheld: decision.keyWithheld,
    approvedOrigins: decision.bindNow ? [origin] : (approvedOrigins ?? []),
    ignoredWorkspaceUrl: setting.ignoredWorkspaceUrl,
  };
}

/**
 * On activation and on a configuration change: when this workspace's settings set
 * a server URL that is not used, say so once per value (remembered per workspace).
 */
export async function showIgnoredWorkspaceUrlNotice(context: vscode.ExtensionContext): Promise<void> {
  const setting = readUrlSetting();
  const ignored = setting.ignoredWorkspaceUrl;
  if (ignored === undefined || ignored === context.workspaceState.get<string>(STATE_IGNORED_URL_NOTICE)) {
    return;
  }
  await context.workspaceState.update(STATE_IGNORED_URL_NOTICE, ignored);
  const openPanel = vscode.l10n.t("Open panel");
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "This workspace's settings set an OmniRoute server URL ({0}). It is not used: the server URL is read from your user settings, and it is {1}.",
      ignored,
      serverRootUrl(setting.baseUrl)
    ),
    openPanel
  );
  if (pick === openPanel) void vscode.commands.executeCommand("omnicopilot.manage");
}

/**
 * Store a new key, approved for one origin only: that of `baseUrl` when given (the
 * URL the user is saving in the panel), else the one currently configured.
 */
export async function storeApiKey(
  context: vscode.ExtensionContext,
  key: string,
  baseUrl?: string
): Promise<void> {
  const origin = originOf(baseUrl ?? configuredBaseUrl());
  // Fail-closed at every step: first an empty list (whichever key is stored is
  // withheld everywhere), then the new key, then its one approved origin. The old
  // key is never approved for the new origin, nor the new key for the old ones,
  // and a key is never left without a list (which would read as pre-1.4.0).
  await writeApprovedOrigins(context, []);
  await context.secrets.store(SECRET_API_KEY, key);
  await writeApprovedOrigins(context, [origin]);
  await warnIfInsecure(context, origin);
}

/**
 * Explicit user action: also send the stored key to the origin of `baseUrl` when
 * given (the URL the user is saving in the panel), else to the one configured.
 */
export async function rebindApiKey(
  context: vscode.ExtensionContext,
  baseUrl?: string
): Promise<void> {
  if (!(await context.secrets.get(SECRET_API_KEY))) return;
  const origin = originOf(baseUrl ?? configuredBaseUrl());
  const approved = (await readApprovedOrigins(context)) ?? [];
  const next = [...approved.filter((item) => item !== origin), origin].slice(-MAX_APPROVED_ORIGINS);
  await writeApprovedOrigins(context, next);
  await warnIfInsecure(context, origin);
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  // The key first: a key left without its list would read as one from before 1.4.0.
  await context.secrets.delete(SECRET_API_KEY);
  await context.secrets.delete(SECRET_API_KEY_ORIGINS);
}

/** Tell the user, once per origin, that a key bound to plain HTTP travels in the clear. */
async function warnIfInsecure(context: vscode.ExtensionContext, origin: string): Promise<void> {
  if (!origin.startsWith("http://") || isLoopbackOrigin(origin)) return;
  const warned = context.globalState.get<string[]>(STATE_INSECURE_WARNED, []);
  if (warned.includes(origin)) return;
  await context.globalState.update(STATE_INSECURE_WARNED, [...warned, origin]);
  void vscode.window.showWarningMessage(
    vscode.l10n.t(
      "The API key for {0} travels over plain HTTP. Anyone on the network path can read it. Prefer HTTPS or a tunnel for a server outside this machine.",
      origin
    )
  );
}

/** The sentence that tells the user why requests leave without their key; undefined when the key is sent. */
export function keyWithheldMessage(connection: Connection): string | undefined {
  if (!connection.keyWithheld) return undefined;
  return vscode.l10n.t(
    "The stored API key was saved for {0} and is not being sent to {1}. Press Save & Test to use it here.",
    connection.approvedOrigins.at(-1) ?? "",
    connection.origin
  );
}

/**
 * After a configuration change: when the stored key is now withheld, say so once
 * per origin (`warned` is the caller's in-memory record) and offer to approve
 * the new server. `onRebound` refreshes whatever depends on the key.
 */
export async function warnIfKeyWithheld(
  context: vscode.ExtensionContext,
  warned: Set<string>,
  onRebound: () => Promise<void>
): Promise<void> {
  const connection = await resolveConnection(context);
  if (!connection.keyWithheld || warned.has(connection.origin)) return;
  warned.add(connection.origin);
  const useHere = vscode.l10n.t("Use the key here");
  const openPanel = vscode.l10n.t("Open panel");
  const pick = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "The OmniRoute server URL is now {0}. The stored API key was saved for {1} and is not being sent to the new server.",
      serverRootUrl(connection.baseUrl),
      connection.approvedOrigins.at(-1) ?? ""
    ),
    useHere,
    openPanel
  );
  if (pick === useHere) {
    // Approve the server the warning named, even if the setting moved again meanwhile.
    await rebindApiKey(context, connection.baseUrl);
    await onRebound();
  } else if (pick === openPanel) {
    void vscode.commands.executeCommand("omnicopilot.manage");
  }
}

/** How long the server URL must stay unchanged before a withheld key is announced.
 * The Settings editor commits a string after a one-second pause in typing. */
export const URL_SETTLE_MS = 1500;

/**
 * Runs `warnIfKeyWithheld` once the configuration has stopped changing for
 * `URL_SETTLE_MS`, resolving the connection again at that moment, so only the URL
 * the user ended on can produce the warning and its "Use the key here".
 */
export function createWithheldKeyWatcher(
  context: vscode.ExtensionContext,
  onRebound: () => Promise<void>,
  onError: (err: unknown) => void
): { schedule(): void; dispose(): void } {
  const warned = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return {
    schedule() {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        warnIfKeyWithheld(context, warned, onRebound).catch(onError);
      }, URL_SETTLE_MS);
    },
    dispose: cancel,
  };
}

/** Explain a failed probe for the server at `baseUrl`, using what this VS Code window knows about itself. */
export function describeProbeFailure(
  baseUrl: string,
  result: Extract<ProbeResult, { ok: false }>,
  timeoutMs: number
): { summary: string; hints: string[] } {
  return explainProbeFailure(result, {
    url: serverRootUrl(baseUrl),
    timeoutSeconds: Math.round(timeoutMs / 1000),
    remoteName: vscode.env.remoteName,
    isLoopback: isLoopbackOrigin(originOf(baseUrl)),
    t: vscode.l10n.t,
  });
}
