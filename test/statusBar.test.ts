import { describe, expect, it, vi } from "vitest";
import { applyStatus, shouldRefreshModels } from "../src/statusBar";

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
  const poll = { source: "poll" as const };

  it("refreshes when a poll takes the status from offline to online with a 2xx probe", () => {
    expect(
      shouldRefreshModels({ previous: "offline", next: "online", probeStatus: 200, ...poll })
    ).toBe(true);
    expect(
      shouldRefreshModels({ previous: "checking", next: "online", probeStatus: 204, ...poll })
    ).toBe(true);
  });

  it.each([401, 403])("does not refresh when the probe was only a %i", (probeStatus) => {
    expect(shouldRefreshModels({ previous: "offline", next: "online", probeStatus, ...poll })).toBe(
      false
    );
  });

  it("does not refresh when the status was already online", () => {
    expect(
      shouldRefreshModels({ previous: "online", next: "online", probeStatus: 200, ...poll })
    ).toBe(false);
  });

  it("does not refresh when the change came from the provider reporting activity", () => {
    expect(
      shouldRefreshModels({
        previous: "offline",
        next: "online",
        probeStatus: 200,
        source: "activity",
      })
    ).toBe(false);
  });

  it("does not refresh on the way to offline", () => {
    expect(
      shouldRefreshModels({ previous: "online", next: "offline", probeStatus: undefined, ...poll })
    ).toBe(false);
  });
});
