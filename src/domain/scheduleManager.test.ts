import { describe, expect, it } from "vitest";

import { isScheduleDue, toSixPartCron } from "./scheduleManager.js";

describe("scheduleManager", () => {
  it("pads five-field cron", () => {
    expect(toSixPartCron("0 9 * * 1-5")).toBe("0 0 9 * * 1-5");
  });

  it("detects schedule due inside window", () => {
    const due = isScheduleDue(
      "0 0 9 * * *",
      "Etc/UTC",
      new Date("2026-05-15T09:05:00.000Z"),
      new Date("2026-05-15T08:00:00.000Z"),
      45,
    );
    expect(due).toBe(true);
  });
});
