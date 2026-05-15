import { describe, expect, it } from "vitest";

import { isQodoBotIdentity } from "./botIdentities.js";

describe("isQodoBotIdentity", () => {
  it("matches display name containing qodo", () => {
    expect(
      isQodoBotIdentity({ displayName: "Qodo Merge", uniqueName: "svc@example.com" }),
    ).toBe(true);
  });

  it("matches unique name containing qodo", () => {
    expect(
      isQodoBotIdentity({ displayName: "Bot", uniqueName: "qodo-bot@example.org" }),
    ).toBe(true);
  });

  it("returns false for normal users", () => {
    expect(
      isQodoBotIdentity({ displayName: "Jamie Lee", uniqueName: "jamie@example.com" }),
    ).toBe(false);
  });
});
