import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { interpolateEnvInString } from "./envInterpolation.js";

describe("envInterpolation", () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original, TEST_TOKEN: "abc123" };
  });

  afterEach(() => {
    process.env = original;
  });

  it("replaces a single placeholder", () => {
    expect(interpolateEnvInString("token=${TEST_TOKEN}")).toBe("token=abc123");
  });

  it("throws when missing", () => {
    expect(() => interpolateEnvInString("${NOPE}")).toThrow(/NOPE/);
  });
});
