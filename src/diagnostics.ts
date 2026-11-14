/** Why the OmniRoute server could not be reached, in words a person can act on.
 * Pure functions only: the caller passes the localisation function, the remote
 * name and the loopback flag, so nothing here depends on the VS Code host. */

export type ProbeFailure =
  | "refused"
  | "timeout"
  | "dns"
  | "unreachable"
  | "tls"
  | "proxy"
  | "http"
  | "unknown";

export type ProbeResult =
  | { ok: true; status: number }
  | { ok: false; failure: ProbeFailure; code?: string; status?: number };

export type Translate = (source: string, ...args: Array<string | number>) => string;

const TLS_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const withCode = err as { code?: unknown; cause?: { code?: unknown } | null };
  const code = withCode.cause?.code ?? withCode.code;
  return typeof code === "string" && code ? code : undefined;
}

/** Node's `fetch` reports a network failure as `TypeError: fetch failed` and puts
 * the real reason in `err.cause.code`. */
export function classifyNetworkError(
  err: unknown,
  timedOut: boolean
): { failure: ProbeFailure; code?: string } {
  const code = errorCode(err);
  const withCode = (failure: ProbeFailure) => (code ? { failure, code } : { failure });

  if (code === "ECONNREFUSED") return withCode("refused");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return withCode("dns");
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EADDRNOTAVAIL") {
    return withCode("unreachable");
  }
  if (timedOut || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return withCode("timeout");
  }
  if (
    code &&
    (code.startsWith("CERT_") ||
      code.startsWith("ERR_TLS") ||
      code.startsWith("ERR_SSL") ||
      TLS_CODES.has(code))
  ) {
    return withCode("tls");
  }
  if (code && (code.includes("PROXY") || code.includes("TUNNEL"))) return withCode("proxy");
  return withCode("unknown");
}

export interface ExplainContext {
  /** The server address shown to the user. */
  url: string;
  timeoutSeconds: number;
  /** `vscode.env.remoteName`: defined when the window is connected to WSL, SSH, a container or a tunnel. */
  remoteName?: string;
  isLoopback: boolean;
  t: Translate;
}

const PROXY_HINT_FAILURES: ReadonlySet<ProbeFailure> = new Set([
  "timeout",
  "refused",
  "unreachable",
  "proxy",
  "unknown",
]);

function summarise(result: Extract<ProbeResult, { ok: false }>, ctx: ExplainContext): string {
  const { url, t } = ctx;
  const code = result.code ?? "unknown";
  switch (result.failure) {
    case "refused":
      return t("Nothing is listening at {0} (connection refused).", url);
    case "timeout":
      return t("No answer from {0} within {1} seconds.", url, ctx.timeoutSeconds);
    case "dns":
      return t("The host name in {0} could not be resolved.", url);
    case "unreachable":
      return t("The network cannot reach {0}.", url);
    case "tls":
      return t("The TLS certificate of {0} was rejected ({1}).", url, code);
    case "proxy":
      return t("The request to {0} failed at a proxy ({1}).", url, code);
    case "http":
      return t(
        "{0} answered HTTP {1}, which is not what an OmniRoute server answers.",
        url,
        result.status ?? 0
      );
    default:
      return t("The request to {0} failed ({1}).", url, code);
  }
}

export function explainProbeFailure(
  result: Extract<ProbeResult, { ok: false }>,
  ctx: ExplainContext
): { summary: string; hints: string[] } {
  const { t } = ctx;
  const hints: string[] = [];
  if (ctx.remoteName) {
    hints.push(
      t(
        "This window is connected to {0}, so the address is resolved on that machine, not on your desktop.",
        ctx.remoteName
      )
    );
  }
  if (!ctx.isLoopback && PROXY_HINT_FAILURES.has(result.failure)) {
    hints.push(
      t(
        "If curl reaches this address from a terminal, VS Code may be routing the request through a proxy. Add the host to the http.noProxy setting."
      )
    );
  }
  if (ctx.isLoopback && result.failure === "refused") {
    hints.push(
      t("Start OmniRoute (npx omniroute), or point Server URL at the machine where it runs.")
    );
  }
  return { summary: summarise(result, ctx), hints };
}

/** Panel text for an offline server: the summary, then each hint on its own line. */
export function formatExplanation(explanation: { summary: string; hints: string[] }): string {
  return [explanation.summary, ...explanation.hints].join("\n");
}
