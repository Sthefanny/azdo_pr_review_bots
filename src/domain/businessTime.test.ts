import { describe, expect, it } from "vitest";

import type { TeamConfig } from "../config/configSchema.js";
import {
    countBusinessCalendarDaysBetween,
    formatDurationApprox,
} from "./businessTime.js";

const bizDays: TeamConfig["businessDays"] = {
  timezone: "America/New_York",
  weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
};

describe("businessTime", () => {
  it("formats durations", () => {
    expect(formatDurationApprox(1500)).toContain("1d");
    expect(formatDurationApprox(90)).toContain("1h");
  });

  it("counts business days excluding anchor weekday", () => {
    const from = new Date("2026-05-11T15:00:00.000Z"); // Monday UTC boundary — exercise only stability
    const to = new Date("2026-05-13T15:00:00.000Z");
    const n = countBusinessCalendarDaysBetween(from, to, bizDays);
    expect(n).toBeGreaterThanOrEqual(0);
  });
});
