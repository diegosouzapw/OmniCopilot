import { describe, expect, it } from "vitest";
import { finiteNonNegative, subsetTokens } from "../src/usage";

describe("finiteNonNegative", () => {
  it.each([0, 1, 12.5])("preserves finite non-negative value %s", (value) => {
    expect(finiteNonNegative(value)).toBe(value);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, undefined, "12"])(
    "rejects invalid value %s",
    (value) => {
      expect(finiteNonNegative(value)).toBeUndefined();
    }
  );
});

describe("subsetTokens", () => {
  it("clamps a subset to its parent token count", () => {
    expect(subsetTokens(75, 50)).toBe(50);
    expect(subsetTokens(12, 4)).toBe(4);
    expect(subsetTokens(3, 10)).toBe(3);
  });

  it("distinguishes an explicit zero from an absent value", () => {
    expect(subsetTokens(0, 100)).toBe(0);
    expect(subsetTokens(undefined, 100)).toBeUndefined();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "uses zero as the safe limit for invalid parent count %s",
    (limit) => {
      expect(subsetTokens(5, limit)).toBe(0);
    }
  );
});
