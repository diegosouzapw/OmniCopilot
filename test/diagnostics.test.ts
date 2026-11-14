import { afterEach, describe, expect, it, vi } from "vitest";
import { OmniRouteClient } from "../src/client";
import {
  classifyNetworkError,
  explainProbeFailure,
  formatExplanation,
  type ExplainContext,
  type ProbeResult,
} from "../src/diagnostics";

/** Same substitution VS Code's l10n.t performs on `{0}`, `{1}`. */
const t: ExplainContext["t"] = (source, ...args) =>
  source.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)]));

function ctx(overrides: Partial<ExplainContext> = {}): ExplainContext {
  return { url: "http://localhost:20128", timeoutSeconds: 4, isLoopback: true, t, ...overrides };
}

const failed = (failure: Extract<ProbeResult, { ok: false }>["failure"], code?: string) =>
  ({ ok: false, failure, code }) as Extract<ProbeResult, { ok: false }>;

describe("classifyNetworkError", () => {
  it.each([
    [{ cause: { code: "ECONNREFUSED" } }, false, "refused"],
    [{ cause: { code: "ENOTFOUND" } }, false, "dns"],
    [{ cause: { code: "EAI_AGAIN" } }, false, "dns"],
    [{ cause: { code: "EHOSTUNREACH" } }, false, "unreachable"],
    [{ cause: { code: "ENETUNREACH" } }, false, "unreachable"],
    [{ cause: { code: "EADDRNOTAVAIL" } }, false, "unreachable"],
    [{ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }, false, "timeout"],
    [{ cause: { code: "ETIMEDOUT" } }, false, "timeout"],
    [{}, true, "timeout"],
    [{ cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } }, false, "tls"],
    [{ cause: { code: "CERT_HAS_EXPIRED" } }, false, "tls"],
    [{ cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }, false, "tls"],
    [{ cause: { code: "ERR_TUNNEL_CONNECTION_FAILED" } }, false, "proxy"],
    [{ cause: { code: "EPIPE" } }, false, "unknown"],
    [new TypeError("fetch failed"), false, "unknown"],
  ])("classifies %j (timedOut=%s) as %s", (err, timedOut, expected) => {
    expect(classifyNetworkError(err, timedOut).failure).toBe(expected);
  });

  it("reads the code from the error itself when there is no cause", () => {
    expect(classifyNetworkError({ code: "ECONNREFUSED" }, false)).toEqual({
      failure: "refused",
      code: "ECONNREFUSED",
    });
  });

  it("keeps the underlying code for the message", () => {
    expect(classifyNetworkError({ cause: { code: "EPIPE" } }, false)).toEqual({
      failure: "unknown",
      code: "EPIPE",
    });
  });

  it("ignores anything that is not an error object", () => {
    expect(classifyNetworkError(undefined, false)).toEqual({ failure: "unknown" });
    expect(classifyNetworkError("boom", false)).toEqual({ failure: "unknown" });
  });
});

describe("explainProbeFailure", () => {
  it("writes the summary for every failure kind", () => {
    const url = "http://h:1";
    const summary = (f: ProbeResult) =>
      explainProbeFailure(f as Extract<ProbeResult, { ok: false }>, ctx({ url })).summary;
    expect(summary(failed("refused"))).toBe("Nothing is listening at http://h:1 (connection refused).");
    expect(summary(failed("timeout"))).toBe("No answer from http://h:1 within 4 seconds.");
    expect(summary(failed("dns"))).toBe("The host name in http://h:1 could not be resolved.");
    expect(summary(failed("unreachable"))).toBe("The network cannot reach http://h:1.");
    expect(summary(failed("tls", "CERT_HAS_EXPIRED"))).toBe(
      "The TLS certificate of http://h:1 was rejected (CERT_HAS_EXPIRED)."
    );
    expect(summary(failed("proxy", "ERR_TUNNEL_CONNECTION_FAILED"))).toBe(
      "The request to http://h:1 failed at a proxy (ERR_TUNNEL_CONNECTION_FAILED)."
    );
    expect(summary(failed("unknown", "EPIPE"))).toBe("The request to http://h:1 failed (EPIPE).");
  });

  it("tells a local user to start the server", () => {
    const { hints } = explainProbeFailure(failed("refused"), ctx({ isLoopback: true }));
    expect(hints).toEqual([
      "Start OmniRoute (npx omniroute), or point Server URL at the machine where it runs.",
    ]);
  });

  it("points a LAN user at the proxy setting", () => {
    const { hints } = explainProbeFailure(
      failed("timeout"),
      ctx({ url: "http://192.168.0.17:20128", isLoopback: false })
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("http.noProxy");
  });

  it("does not suggest the proxy setting for a name that does not resolve or a rejected certificate", () => {
    for (const f of ["dns", "tls", "http"] as const) {
      const { hints } = explainProbeFailure(failed(f), ctx({ isLoopback: false }));
      expect(hints).toEqual([]);
    }
  });

  it("explains where the address is resolved in a remote window", () => {
    const { hints } = explainProbeFailure(
      failed("refused"),
      ctx({ remoteName: "wsl", isLoopback: true })
    );
    expect(hints).toEqual([
      "This window is connected to wsl, so the address is resolved on that machine, not on your own computer.",
      "Start OmniRoute (npx omniroute), or point Server URL at the machine where it runs.",
    ]);
  });

  it("puts the remote hint before the proxy hint", () => {
    const { hints } = explainProbeFailure(
      failed("timeout"),
      ctx({ remoteName: "ssh-remote", isLoopback: false })
    );
    expect(hints[0]).toContain("ssh-remote");
    expect(hints[1]).toContain("http.noProxy");
  });

  it("reports an HTTP answer that is not an OmniRoute API", () => {
    const { summary } = explainProbeFailure(
      { ok: false, failure: "http", status: 404 },
      ctx({ url: "http://h:1" })
    );
    expect(summary).toBe("http://h:1 answered HTTP 404, which is not what an OmniRoute server answers.");
  });

  it("formats the panel text with one line per hint", () => {
    const text = formatExplanation(
      explainProbeFailure(failed("refused"), ctx({ remoteName: "wsl" }))
    );
    expect(text.split("\n")).toHaveLength(3);
    expect(text.startsWith("Nothing is listening")).toBe(true);
  });
});

describe("OmniRouteClient.probe", () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () => new OmniRouteClient({ baseUrl: "http://x/v1" });
  const reply = (status: number) => new Response(null, { status });

  it("is ok on HEAD 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200));
    vi.stubGlobal("fetch", fetchMock);
    expect(await client().probe()).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("HEAD");
  });

  it("treats 401 and 403 as a server that answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(401)));
    expect(await client().probe()).toEqual({ ok: true, status: 401 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(403)));
    expect(await client().probe()).toEqual({ ok: true, status: 403 });
  });

  it("falls back to GET when the server does not implement HEAD", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(405)).mockResolvedValueOnce(reply(200));
    vi.stubGlobal("fetch", fetchMock);
    expect(await client().probe()).toEqual({ ok: true, status: 200 });
    expect(fetchMock.mock.calls.map((c) => c[1]?.method)).toEqual(["HEAD", "GET"]);
  });

  it.each([404, 501])("also falls back to GET after HEAD %i", async (status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(status)).mockResolvedValueOnce(reply(401));
    vi.stubGlobal("fetch", fetchMock);
    expect(await client().probe()).toEqual({ ok: true, status: 401 });
  });

  it("reports an HTTP failure when GET answers with another status too", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(404)));
    expect(await client().probe()).toEqual({ ok: false, failure: "http", status: 404 });
  });

  it("does not retry another status (a 500 stays a 500)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(500));
    vi.stubGlobal("fetch", fetchMock);
    expect(await client().probe()).toEqual({ ok: false, failure: "http", status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a refused connection", async () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    expect(await client().probe()).toEqual({ ok: false, failure: "refused", code: "ECONNREFUSED" });
  });

  it("reports a timeout when the request is aborted by the deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
            );
          })
      )
    );
    expect(await client().probe(20)).toEqual({ ok: false, failure: "timeout" });
  });

  it("keeps ping() as a boolean on top of probe()", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200)));
    expect(await client().ping()).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(await client().ping()).toBe(false);
  });
});
