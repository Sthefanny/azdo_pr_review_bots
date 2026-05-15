import { describe, expect, it } from "vitest";

import { mapConcurrent } from "./mapConcurrent.js";

describe("mapConcurrent", () => {
  it("preserves order and limits concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5];
    const results = await mapConcurrent(items, 2, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
