import * as vscode from "vscode";
import { DEFAULT_BASE_URL, normalizeBaseUrl } from "./client";

/** SecretStorage entry holding the API key. */
export const SECRET_API_KEY = "omnicopilot.apiKey";
/** globalState entry holding the origin the stored key was saved for. */
export const STATE_API_KEY_ORIGIN = "omnicopilot.apiKeyOrigin";
/** globalState entry listing the plain-HTTP origins the user was already warned about. */
const STATE_INSECURE_WARNED = "omnicopilot.insecureOriginsWarned";

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
