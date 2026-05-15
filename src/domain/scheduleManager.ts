import CronExpressionParser from "cron-parser";

/** Azure Functions expects 6-field NCRONTAB. Config may supply 5-field crons. */
export function toSixPartCron(expression: string): string {
  const trimmed = expression.trim();
  const parts = trimmed.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 6) return trimmed;
  if (parts.length === 5) return `0 ${trimmed}`;
  throw new Error(`Cron expression must have 5 or 6 fields: "${expression}"`);
}

/**
 * Returns `true` when the schedule has fired for an occurrence after `lastPostedAtUtc`
 * but on/before `nowUtc` in `timeZone`.
 */
export function isScheduleDue(
  expression: string,
  timeZone: string,
  nowUtc: Date,
  lastPostedAtUtc: Date | null,
  timerWindowMinutes: number,
): boolean {
  const cron = toSixPartCron(expression);
  const windowMs = Math.max(5, timerWindowMinutes) * 60_000;

  const prev = CronExpressionParser.parse(cron, {
    currentDate: nowUtc,
    tz: timeZone,
  }).prev();
  const fire = prev.toDate();

  if (fire.getTime() > nowUtc.getTime()) return false;
  if (nowUtc.getTime() - fire.getTime() > windowMs) return false;

  if (!lastPostedAtUtc) return true;
  return fire.getTime() > lastPostedAtUtc.getTime();
}
