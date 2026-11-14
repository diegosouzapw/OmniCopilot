import * as vscode from "vscode";
import { DEFAULT_BASE_URL, normalizeBaseUrl, serverRootUrl } from "./client";
import { explainProbeFailure, type ProbeResult } from "./diagnostics";

/** SecretStorage entry holding the API key. */
export const SECRET_API_KEY = "omnicopilot.apiKey";
/** globalState entry holding the origin the stored key was saved for. */
export const STATE_API_KEY_ORIGIN = "omnicopilot.apiKeyOrigin";
/** globalState entry listing the plain-HTTP origins the user was already warned about. */
const STATE_INSECURE_WARNED = "omnicopilot.insecureOriginsWarned";
/** globalState entry set by the first-run welcome; present means an existing install. */
const STATE_WELCOMED = "omnicopilot.welcomed";
/** globalState entry naming the release whose one-time notice was already handled. */
const STATE_NOTICE_VERSION = "omnicopilot.noticeVersion";
const NOTICE_VERSION = "1.4.0";

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
  boundOrigin?: string;
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
 * The key goes only to the origin it was saved for. A key from an install that
 * predates the binding is adopted by the current origin; after that, a changed
 * URL keeps the key at home until the user rebinds it on purpose.
 */
export function decideKeyUse(args: {
  storedKey?: string;
  boundOrigin?: string;
  currentOrigin: string;
}): { apiKey?: string; keyWithheld: boolean; bindNow: boolean } {
  const { storedKey, boundOrigin, currentOrigin } = args;
  if (!storedKey) return { apiKey: undefined, keyWithheld: false, bindNow: false };
  if (!boundOrigin) return { apiKey: storedKey, keyWithheld: false, bindNow: true };
  if (boundOrigin === currentOrigin) {
    return { apiKey: storedKey, keyWithheld: false, bindNow: false };
  }
  return { apiKey: undefined, keyWithheld: true, bindNow: false };
}

function configuredBaseUrl(): string {
  return normalizeBaseUrl(
    vscode.workspace
      .getConfiguration("omnicopilot")
      .get<string>("baseUrl", DEFAULT_BASE_URL)
  );
}

/** The one place that reads `omnicopilot.baseUrl` and the stored API key. */
export async function resolveConnection(context: vscode.ExtensionContext): Promise<Connection> {
  const baseUrl = configuredBaseUrl();
  const origin = originOf(baseUrl);
  const storedKey = (await context.secrets.get(SECRET_API_KEY)) || undefined;
  const boundOrigin = context.globalState.get<string>(STATE_API_KEY_ORIGIN) || undefined;

  const decision = decideKeyUse({ storedKey, boundOrigin, currentOrigin: origin });
  if (decision.bindNow) {
    await context.globalState.update(STATE_API_KEY_ORIGIN, origin);
  }
  return {
    baseUrl,
    origin,
    apiKey: decision.apiKey,
    hasStoredKey: Boolean(storedKey),
    keyWithheld: decision.keyWithheld,
    boundOrigin: decision.bindNow ? origin : boundOrigin,
  };
}

/**
 * Which one-time notice an activation owes the user about the server URL now being
 * read from user settings only. A fresh install has nothing to unlearn.
 */
export function upgradeNotice(args: {
  welcomed: boolean;
  noticeVersion: string | undefined;
  hasStoredKey: boolean;
}): "none" | "with-key" | "without-key" {
  if (!args.welcomed || args.noticeVersion === NOTICE_VERSION) return "none";
  return args.hasStoredKey ? "with-key" : "without-key";
}

/**
 * On activation: tell an existing install, once, that a workspace's server URL is
 * no longer read and which URL is in effect. A fresh install only gets the marker.
 */
export async function showUpgradeNoticeOnce(context: vscode.ExtensionContext): Promise<void> {
  // Read both markers before the first await: the first-run welcome sets
  // `welcomed` on a fresh install as soon as it runs.
  const welcomed = context.globalState.get<boolean>(STATE_WELCOMED) === true;
  const noticeVersion = context.globalState.get<string>(STATE_NOTICE_VERSION);
  if (noticeVersion === NOTICE_VERSION) return;
  await context.globalState.update(STATE_NOTICE_VERSION, NOTICE_VERSION);
  if (!welcomed) return;

  const connection = await resolveConnection(context);
  const notice = upgradeNotice({ welcomed, noticeVersion, hasStoredKey: connection.hasStoredKey });
  if (notice === "none") return;
  const root = serverRootUrl(connection.baseUrl);
  const message =
    notice === "with-key"
      ? vscode.l10n.t(
          "OmniRoute now reads the server URL only from your user settings. It is {0}, and a URL set in a workspace's settings is no longer used. Your API key is tied to that server.",
          root
        )
      : vscode.l10n.t(
          "OmniRoute now reads the server URL only from your user settings. It is {0}, and a URL set in a workspace's settings is no longer used.",
          root
        );
  const openPanel = vscode.l10n.t("Open panel");
  const pick = await vscode.window.showInformationMessage(message, openPanel);
  if (pick === openPanel) void vscode.commands.executeCommand("omnicopilot.manage");
}

/** Store the key and bind it to the origin currently configured. */
export async function storeApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store(SECRET_API_KEY, key);
  await bindToCurrentOrigin(context);
}

/** Explicit user action: send the stored key to the origin currently configured. */
export async function rebindApiKey(context: vscode.ExtensionContext): Promise<void> {
  if (!(await context.secrets.get(SECRET_API_KEY))) return;
  await bindToCurrentOrigin(context);
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_API_KEY);
  await context.globalState.update(STATE_API_KEY_ORIGIN, undefined);
}

async function bindToCurrentOrigin(context: vscode.ExtensionContext): Promise<void> {
  const origin = originOf(configuredBaseUrl());
  await context.globalState.update(STATE_API_KEY_ORIGIN, origin);
  await warnIfInsecure(context, origin);
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
    connection.boundOrigin ?? "",
    connection.origin
  );
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
