import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import {
    runDailyReviewDebtJob,
    runPersonalSubscriptionsJob,
    runWeeklyLeaderboardJob,
} from "../runReviewHealthJob.js";

function okJson(): HttpResponseInit {
  return { status: 200, jsonBody: { ok: true } };
}

app.http("dailyReviewDebtHttp", {
  methods: ["POST"],
  route: "review-health/daily-review-debt",
  authLevel: "function",
  handler: async (_req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    await runDailyReviewDebtJob(context);
    return okJson();
  },
});

app.http("weeklyLeaderboardHttp", {
  methods: ["POST"],
  route: "review-health/weekly-leaderboard",
  authLevel: "function",
  handler: async (_req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    await runWeeklyLeaderboardJob(context);
    return okJson();
  },
});

app.http("personalSubscriptionsHttp", {
  methods: ["POST"],
  route: "review-health/personal-subscriptions",
  authLevel: "function",
  handler: async (_req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    await runPersonalSubscriptionsJob(context);
    return okJson();
  },
});
