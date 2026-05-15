import { app, type InvocationContext, type Timer } from "@azure/functions";
import {
    runDailyReviewDebtJob,
    runPersonalSubscriptionsJob,
    runWeeklyLeaderboardJob,
} from "../runReviewHealthJob.js";

function envRunOnStartup(): boolean {
  const raw = process.env.TIMER_RUN_ON_STARTUP?.toLowerCase().trim();
  return raw === "true" || raw === "1" || raw === "yes";
}

const scheduleDaily = process.env.TIMER_SCHEDULE_DAILY_REVIEW_DEBT ?? "0 0 9 * * 1-5";
const scheduleWeekly = process.env.TIMER_SCHEDULE_WEEKLY_LEADERBOARD ?? "0 0 10 * * 5";
const scheduleSubscriptions = process.env.TIMER_SCHEDULE_PERSONAL_SUBSCRIPTIONS ?? "0 */15 * * * *";

app.timer("dailyReviewDebtTimer", {
  schedule: scheduleDaily,
  runOnStartup: envRunOnStartup(),
  handler: async (timer: Timer, context: InvocationContext): Promise<void> => {
    context.log(`dailyReviewDebtTimer fired at ${timer.scheduleStatus?.last ?? "unknown"}`);
    await runDailyReviewDebtJob(context);
  },
});

app.timer("weeklyLeaderboardTimer", {
  schedule: scheduleWeekly,
  runOnStartup: envRunOnStartup(),
  handler: async (timer: Timer, context: InvocationContext): Promise<void> => {
    context.log(`weeklyLeaderboardTimer fired at ${timer.scheduleStatus?.last ?? "unknown"}`);
    await runWeeklyLeaderboardJob(context);
  },
});

app.timer("personalSubscriptionsTimer", {
  schedule: scheduleSubscriptions,
  runOnStartup: envRunOnStartup(),
  handler: async (timer: Timer, context: InvocationContext): Promise<void> => {
    context.log(`personalSubscriptionsTimer fired at ${timer.scheduleStatus?.last ?? "unknown"}`);
    await runPersonalSubscriptionsJob(context);
  },
});
