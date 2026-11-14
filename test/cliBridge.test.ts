import { describe, expect, it } from "vitest";
import { isSafeCliPath } from "../src/cliBridge";

describe("isSafeCliPath", () => {
  it.each([
    "omniroute",
    "npx omniroute",
    "/usr/local/bin/omniroute",
    "C:\\Program Files\\nodejs\\omniroute.cmd",
    "~/bin/omniroute",
  ])("accepts %s", (value) => {
    expect(isSafeCliPath(value)).toBe(true);
  });

  it.each([
    "omniroute; curl x | sh",
    "omniroute && id",
    "`id`",
    "$(id)",
    "omniroute | tee",
    "a\nb",
    "omni'route",
    'omni"route',
    "omniroute > f",
    "",
  ])("rejects %j", (value) => {
    expect(isSafeCliPath(value)).toBe(false);
  });
});
