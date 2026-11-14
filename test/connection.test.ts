import { describe, expect, it } from "vitest";
import { decideKeyUse, isLoopbackOrigin, originOf } from "../src/connection";

describe("originOf", () => {
  it.each([
    ["http://LocalHost:20128/v1/", "http://localhost:20128"],
    ["localhost:20128", "http://localhost:20128"],
    ["https://Example.com/v1", "https://example.com"],
    ["http://[::1]:20128/", "http://[::1]:20128"],
    ["https://example.com:8443/some/path", "https://example.com:8443"],
    ["", "http://localhost:20128"],
  ])("reduces %s to scheme, lower-case host and port", (input, expected) => {
    expect(originOf(input)).toBe(expected);
  });

  it("ignores the path, so /v1 or no /v1 yields the same origin", () => {
    expect(originOf("https://example.com")).toBe(originOf("https://example.com/v1/"));
  });
});

describe("isLoopbackOrigin", () => {
  it.each([
    "http://localhost:20128",
    "http://127.0.0.1:20128",
    "http://127.1.2.3:20128",
    "http://[::1]:20128",
    "https://localhost",
  ])("recognises %s as loopback", (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(true);
  });

  it.each([
    "http://192.168.0.4:20128",
    "https://example.com",
    "http://localhost.evil.example",
    "http://127.0.0.1.evil.example",
    "http://127.0.0.256:20128",
    "not a url",
  ])("does not treat %s as loopback", (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(false);
  });
});

describe("decideKeyUse", () => {
  const local = "http://localhost:20128";

  it("sends no key when none is stored", () => {
    expect(decideKeyUse({ currentOrigin: local })).toEqual({
      apiKey: undefined,
      keyWithheld: false,
      bindNow: false,
    });
  });

  it("treats an empty stored key as no key", () => {
    expect(decideKeyUse({ storedKey: "", boundOrigin: local, currentOrigin: local })).toEqual({
      apiKey: undefined,
      keyWithheld: false,
      bindNow: false,
    });
  });

  it("uses a key that was never bound and asks to bind it now", () => {
    expect(decideKeyUse({ storedKey: "sk-1", currentOrigin: local })).toEqual({
      apiKey: "sk-1",
      keyWithheld: false,
      bindNow: true,
    });
  });

  it("uses a key bound to the current origin", () => {
    expect(decideKeyUse({ storedKey: "sk-1", boundOrigin: local, currentOrigin: local })).toEqual({
      apiKey: "sk-1",
      keyWithheld: false,
      bindNow: false,
    });
  });

  it("withholds a key bound to another origin", () => {
    expect(
      decideKeyUse({
        storedKey: "sk-1",
        boundOrigin: local,
        currentOrigin: "https://evil.example",
      })
    ).toEqual({ apiKey: undefined, keyWithheld: true, bindNow: false });
  });
});
