import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { OmniRouteClient } from "../src/client";
import type { ProbeResult } from "../src/diagnostics";
import {
  ConnectionStatusBar,
  applyStatus,
  shouldRefreshModels,
  statusPresentation,
} from "../src/statusBar";

describe("applyStatus", () => {
  it("notifies only when the status actually changes", () => {
    const notify = vi.fn();
    let status = applyStatus("checking", "offline", notify);
    expect(status).toBe("offline");
    status = applyStatus(status, "offline", notify);
    expect(status).toBe("offline");
    expect(notify).toHaveBeenCalledTimes(1);

    status = applyStatus(status, "online", notify);
    status = applyStatus(status, "online", notify);
    expect(status).toBe("online");
    expect(notify.mock.calls).toEqual([["offline"], ["online"]]);
  });

  it("works without a listener", () => {
    expect(applyStatus("online", "offline")).toBe("offline");
  });
});

describe("shouldRefreshModels", () => {
  it("refreshes after the first accepted poll", () => {
    expect(shouldRefreshModels({ previousPollOk: undefined, pollOk: true })).toBe(true);
  });

  it("does not refresh after an accepted poll that followed an accepted poll", () => {
    expect(shouldRefreshModels({ previousPollOk: true, pollOk: true })).toBe(false);
  });

  it("refreshes after an accepted poll that followed a failed or 401/403 poll", () => {
    expect(shouldRefreshModels({ previousPollOk: false, pollOk: true })).toBe(true);
  });

  it("does not refresh on a poll that was not accepted", () => {
    expect(shouldRefreshModels({ previousPollOk: undefined, pollOk: false })).toBe(false);
    expect(shouldRefreshModels({ previousPollOk: true, pollOk: false })).toBe(false);
    expect(shouldRefreshModels({ previousPollOk: false, pollOk: false })).toBe(false);
  });
});

describe("ConnectionStatusBar model refill", () => {
  function bar(answers: ProbeResult[]) {
    const onModelsReachable = vi.fn();
    const client = {
      baseUrl: "http://gateway.test/v1",
      probe: async () => {
        const next = answers.shift();
        if (!next) throw new Error("no probe answer left");
        return next;
      },
    };
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const statusBar = new ConnectionStatusBar(
      async () => client as unknown as OmniRouteClient,
      log as unknown as vscode.LogOutputChannel,
      undefined,
      undefined,
      onModelsReachable
    );
    return { statusBar, onModelsReachable };
  }

  it("compares poll to poll and ignores status changes reported by requests", async () => {
    const { statusBar, onModelsReachable } = bar([
      { ok: true, status: 200 },
      { ok: true, status: 200 },
      { ok: true, status: 200 },
      { ok: false, failure: "refused" },
      { ok: true, status: 200 },
      { ok: true, status: 401 },
      { ok: true, status: 200 },
    ]);

    await statusBar.checkNow(); // first poll accepted
    expect(onModelsReachable).toHaveBeenCalledTimes(1);
    await statusBar.checkNow(); // accepted after accepted
    expect(onModelsReachable).toHaveBeenCalledTimes(1);

    statusBar.reportActivity(false); // a listing failed between two accepted polls
    await statusBar.checkNow();
    expect(onModelsReachable).toHaveBeenCalledTimes(1);

    await statusBar.checkNow(); // unreachable
    await statusBar.checkNow(); // back
    expect(onModelsReachable).toHaveBeenCalledTimes(2);

    await statusBar.checkNow(); // 401: there, but the listing would be refused
    expect(onModelsReachable).toHaveBeenCalledTimes(2);
    await statusBar.checkNow();
    expect(onModelsReachable).toHaveBeenCalledTimes(3);
    statusBar.dispose();
  });
});

describe("statusPresentation", () => {
  it("shows a warning on an online server while the stored key is withheld", () => {
    expect(statusPresentation({ status: "online", keyWithheld: true })).toEqual({
      text: "$(warning) OmniRoute",
      color: undefined,
      background: "statusBarItem.warningBackground",
    });
  });

  it("shows the green dot on an online server that gets the key (or needs none)", () => {
    expect(statusPresentation({ status: "online", keyWithheld: false })).toEqual({
      text: "$(circle-filled) OmniRoute",
      color: "testing.iconPassed",
      background: undefined,
    });
  });

  it.each([true, false])("shows an unreachable server as offline (key withheld: %s)", (keyWithheld) => {
    expect(statusPresentation({ status: "offline", keyWithheld })).toEqual({
      text: "$(circle-outline) OmniRoute",
      color: undefined,
      background: "statusBarItem.warningBackground",
    });
  });

  it("spins while checking", () => {
    expect(statusPresentation({ status: "checking", keyWithheld: true })).toEqual({
      text: "$(sync~spin) OmniRoute",
      color: undefined,
      background: undefined,
    });
  });
});
