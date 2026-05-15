import { DateTime } from "luxon";

import type { TeamConfig } from "../config/configSchema.js";

const ALL_DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function weekdayNumbersForConfig(
  weekdays: TeamConfig["businessDays"]["weekdays"],
): Set<number> {
  const set = new Set<number>();
  for (const label of weekdays) {
    const idx = ALL_DAYS.indexOf(label);
    if (idx >= 0) set.add(idx);
  }
  return set;
}

/**
 * Count elapsed business-calendar days AFTER the calendar day holding `fromUtc`,
 * through the calendar day holding `toUtc`. Weekends/weekdays obey `businessDays`.
 */
export function countBusinessCalendarDaysBetween(
  fromUtc: Date,
  toUtc: Date,
  cfg: TeamConfig["businessDays"],
): number {
  const zone = cfg.timezone;
  const allowed = weekdayNumbersForConfig(cfg.weekdays);

  const start = DateTime.fromJSDate(fromUtc, { zone: "utc" })
    .setZone(zone)
    .startOf("day");
  const end = DateTime.fromJSDate(toUtc, { zone: "utc" })
    .setZone(zone)
    .startOf("day");

  if (end < start) return 0;

  let cursor = start;
  let count = 0;
  while (cursor <= end) {
    if (allowed.has(cursor.weekday % 7)) count += 1;
    cursor = cursor.plus({ days: 1 });
  }

  if (allowed.has(start.weekday % 7)) count -= 1;

  return Math.max(0, count);
}

/** Format durations like “2d 4h”. */
export function formatDurationApprox(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return "0m";
  const days = Math.floor(totalMinutes / (60 * 24));
  let remaining = Math.floor(totalMinutes - days * 24 * 60);
  const hours = Math.floor(remaining / 60);
  remaining -= hours * 60;
  const mins = Math.max(0, remaining);

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && mins) parts.push(`${mins}m`);
  else if (!days && !hours) parts.push(`${mins}m`);

  return parts.join(" ").trim().length ? parts.join(" ") : "0m";
}

export function diffMinutesApprox(
  startUtc?: Date | null,
  endUtc?: Date | null,
): number | null {
  if (!startUtc || !endUtc) return null;
  return Math.round((endUtc.getTime() - startUtc.getTime()) / (60 * 1000));
}
