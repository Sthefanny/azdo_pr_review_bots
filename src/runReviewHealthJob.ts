import type { InvocationContext } from "@azure/functions";

import { AzureDevOpsClient, type PolicyConfiguration } from "./clients/azureDevOpsClient.js";
import { fetchRandomCelebrationGif } from "./clients/giphyClient.js";
import { postSlackDm } from "./clients/slackBotClient.js";
import { postSlackWebhook } from "./clients/slackWebhookClient.js";
import type { TableClientsBundle } from "./clients/tableStorageClient.js";
import {
    createTableClients,
    getScheduleState,
    listSnapshots,
    listSubscriptions,
    loadNotificationStates,
    pruneMissingSnapshots,
    releaseTimerLease,
    saveScheduleState,
    tryAcquireTimerLease,
    upsertNotificationState,
    upsertSnapshot,
    upsertSubscription,
} from "./clients/tableStorageClient.js";
import { getEnvOrWarn, loadAppConfig, resolveTeamSecrets } from "./config/configLoader.js";
import type { TeamConfig } from "./config/configSchema.js";
import { calculateLeaderboard, collectLeaderboardInsights } from "./domain/leaderboardCalculator.js";
import {
    buildDailyReviewDebtRichMessage,
    buildWeeklyLeaderboardRichMessage,
} from "./domain/messageBuilder.js";
import { detectPersonalNotificationEvents } from "./domain/personalNotificationDetector.js";
import { buildPullRequestSnapshot, prIncludedByLabel } from "./domain/prSnapshotBuilder.js";
import { calculateReviewDebtMetrics } from "./domain/reviewDebtCalculator.js";
import { isScheduleDue } from "./domain/scheduleManager.js";
import { slackUserIdForEmail, subscriptionsForSnapshot } from "./domain/subscriptionManager.js";
import type { NotificationState, PullRequestSnapshot, Subscription } from "./models/domainTypes.js";
import { leaseKeyForSegment, type ReviewHealthSegment } from "./reviewHealthSegments.js";
import { utcNow } from "./utils/dateTime.js";
import { fnv1aHex } from "./utils/hash.js";
import { createLogger } from "./utils/logger.js";
import { mapConcurrent } from "./utils/mapConcurrent.js";

const logger = createLogger("review-health");

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.toLowerCase().trim();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return defaultValue;
}

/** Integer env in [1, max], default when missing/invalid. */
function envPositiveInt(name: string, defaultValue: number, max: number): number {
  const raw = process.env[name];
  const n = raw !== undefined && raw !== "" ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return defaultValue;
  return Math.min(n, max);
}

function requireEnv(name: string): string {
  const v = getEnvOrWarn(name);
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export interface ProcessTeamDeps {
  dryRun: boolean;
  immediateLeaderboard: boolean;
  immediateReviewDebt: boolean;
  saveState: boolean;
  segments: ReadonlySet<ReviewHealthSegment>;
}

async function processTeam(team: TeamConfig, tables: TableClientsBundle, deps: ProcessTeamDeps): Promise<void> {
  if (!team.enabled) return;

  const pat = resolveTeamSecrets(team.id, team.azureDevOps.patEnvVar);
  const webhookUrl = resolveTeamSecrets(team.id, team.slack.webhookEnvVar);
  const botToken = resolveTeamSecrets(team.id, team.slack.botTokenEnvVar);

  const needsSlackBot = deps.segments.has("subscriptions") && team.subscriptions.enabled;
  if (!pat || !webhookUrl || (needsSlackBot && !botToken)) {
    logger.warn(
      `Skipping team ${team.id}: missing secrets (PAT + webhook${needsSlackBot ? " + Slack bot token" : ""})`,
    );
    return;
  }

  const tokenForDm = botToken ?? "";

  const ado = new AzureDevOpsClient({ team: team.azureDevOps, logger, personalAccessToken: pat });
  const now = utcNow();

  const needActiveSnapshots =
    deps.segments.has("review-debt") || deps.segments.has("subscriptions");

  const prevById = new Map<number, PullRequestSnapshot>();
  if (needActiveSnapshots) {
    for (const s of await listSnapshots(team.id, tables.snapshots)) {
      prevById.set(s.pullRequestId, s);
    }
  }

  let snapshots: PullRequestSnapshot[] = [];

  if (needActiveSnapshots) {
    const minCreatedActive =
      team.azureDevOps.activePullRequestCreatedWithinDays !== undefined
        ? new Date(now.getTime() - team.azureDevOps.activePullRequestCreatedWithinDays * 86_400_000)
        : undefined;
    if (minCreatedActive) {
      logger.info(
        `Team ${team.id}: active PRs limited to created on/after ${minCreatedActive.toISOString()} (${team.azureDevOps.activePullRequestCreatedWithinDays}d)`,
      );
    }

    const active = await ado.listPullRequests({
      status: "active",
      top: 200,
      minCreated: minCreatedActive,
    });
    const inScope = active.filter((p) => {
      if (p.isDraft) return false;
      return prIncludedByLabel(p, team.azureDevOps);
    });

    const prConcurrency = envPositiveInt("PR_SNAPSHOT_CONCURRENCY", 8, 32);
    const branchPolicyLoadCache = new Map<string, Promise<PolicyConfiguration[]>>();

    snapshots = await mapConcurrent(inScope, prConcurrency, async (pr) => {
      const threads = await ado.getThreads(pr.pullRequestId);
      const snap = await buildPullRequestSnapshot({
        branchPolicyLoadCache,
        team,
        teamId: team.id,
        client: ado,
        pullRequestId: pr.pullRequestId,
        previous: prevById.get(pr.pullRequestId) ?? null,
        threadsRaw: threads,
      });

      if (
        deps.segments.has("subscriptions") &&
        team.subscriptions.enabled &&
        deps.saveState &&
        !deps.dryRun
      ) {
        const subs = subscriptionsForSnapshot(team, snap, threads);
        await Promise.all(subs.map((sub) => upsertSubscription(tables.subscriptions, sub)));
      }

      return snap;
    });
  }

  if (needActiveSnapshots && deps.segments.has("subscriptions") && team.subscriptions.enabled) {
    const activeSubs = await listSubscriptions(team.id, tables.subscriptions);
    const subscribersByPr = new Map<number, Subscription[]>();
    for (const sub of activeSubs) {
      if (!sub.isActive) continue;
      const list = subscribersByPr.get(sub.pullRequestId) ?? [];
      list.push(sub);
      subscribersByPr.set(sub.pullRequestId, list);
    }

    for (const snap of snapshots) {
      const prev = prevById.get(snap.pullRequestId) ?? null;
      const prUrl = ado.pullRequestHtmlUrl(team.azureDevOps, snap.pullRequestId);
      const events = detectPersonalNotificationEvents({ team, previous: prev, current: snap, prUrl });

      for (const event of events) {
        const subs = subscribersByPr.get(snap.pullRequestId) ?? [];
        let targets = subs.map((s) => s.slackUserId);

        if (event.authorOnly) {
          const authorSlack = slackUserIdForEmail(team, snap.authorEmail);
          targets = authorSlack ? [authorSlack] : [];
        }

        const uniqueTargets = [...new Set(targets)];
        for (const userId of uniqueTargets) {
          const hash = fnv1aHex(
            JSON.stringify({
              t: event.type,
              pr: snap.pullRequestId,
              u: userId,
              p: event.dedupeParts,
            }),
          );

          const prior = await loadNotificationStates(
            tables.notifications,
            team.id,
            snap.pullRequestId,
          );
          const duplicate = prior.some(
            (p) => p.slackUserId === userId && p.eventType === event.type && p.lastEventHash === hash,
          );
          if (duplicate) continue;

          try {
            await postSlackDm({ botToken: tokenForDm, userId, text: event.text, dryRun: deps.dryRun });
            if (deps.saveState && !deps.dryRun) {
              const row: NotificationState = {
                teamId: team.id,
                pullRequestId: snap.pullRequestId,
                eventType: event.type,
                slackUserId: userId,
                lastEventHash: hash,
                lastNotifiedAtUtc: utcNow(),
              };
              await upsertNotificationState(tables.notifications, row);
            }
          } catch (err) {
            logger.error(`DM failed for ${userId} on PR ${snap.pullRequestId}`, err);
          }
        }
      }
    }
  }

  if (needActiveSnapshots && deps.segments.has("review-debt") && team.reviewDebt.enabled) {
    const metrics = calculateReviewDebtMetrics(snapshots, team, now);
    const lastPosted =
      (await getScheduleState(tables.schedule, team.id, "daily-review-debt"))?.lastPostedAtUtc ?? null;
    const due =
      deps.immediateReviewDebt ||
      isScheduleDue(team.reviewDebt.schedule, team.businessDays.timezone, now, lastPosted, 45);

    if (due) {
      const message = buildDailyReviewDebtRichMessage(team, metrics, (id) =>
        ado.pullRequestHtmlUrl(team.azureDevOps, id),
      );
      try {
        logger.info(`Posting daily review-debt Slack webhook for team ${team.id}`);
        await postSlackWebhook({ webhookUrl, message, dryRun: deps.dryRun });
        if (deps.saveState && !deps.dryRun) {
          await saveScheduleState(tables.schedule, {
            teamId: team.id,
            scheduleName: "daily-review-debt",
            lastPostedAtUtc: now,
            lastRunAtUtc: now,
          });
        }
      } catch (err) {
        logger.error("Daily debt webhook failed; not updating schedule state", err);
      }
    }
  }

  if (deps.segments.has("leaderboard") && team.leaderboard.enabled) {
    const minClosed = new Date(now.getTime() - team.leaderboard.lookbackDays * 86_400_000);
    const completed = await ado.listRecentlyClosedPullRequests({
      minClosedUtc: minClosed,
      top: 400,
    });
    const prConcurrency = envPositiveInt("PR_SNAPSHOT_CONCURRENCY", 8, 32);
    const lbConcurrency = envPositiveInt("LEADERBOARD_ADO_CONCURRENCY", prConcurrency, 32);
    const insights = await collectLeaderboardInsights(ado, team, completed, {
      concurrency: lbConcurrency,
    });
    const board = calculateLeaderboard(insights, team);

    const lastPostedLb =
      (await getScheduleState(tables.schedule, team.id, "weekly-leaderboard"))?.lastPostedAtUtc ?? null;
    const dueLb =
      deps.immediateLeaderboard ||
      isScheduleDue(
        team.leaderboard.schedule,
        team.businessDays.timezone,
        now,
        lastPostedLb,
        45,
      );

    if (dueLb) {
      let winnerGif: { imageUrl: string; altText: string } | undefined;
      const giphyEnv = team.leaderboard.giphyApiKeyEnvVar;
      if (
        !deps.dryRun &&
        giphyEnv &&
        team.leaderboard.showTopReviewers > 0 &&
        board.topReviewers.length > 0
      ) {
        const giphyKey = getEnvOrWarn(giphyEnv);
        if (giphyKey) {
          const fetched = await fetchRandomCelebrationGif({ apiKey: giphyKey, logger });
          if (fetched) winnerGif = fetched;
        }
      }

      const message = buildWeeklyLeaderboardRichMessage(team, board, { winnerGif });
      try {
        logger.info(`Posting weekly leaderboard Slack webhook for team ${team.id}`);
        await postSlackWebhook({ webhookUrl, message, dryRun: deps.dryRun });
        if (deps.saveState && !deps.dryRun) {
          await saveScheduleState(tables.schedule, {
            teamId: team.id,
            scheduleName: "weekly-leaderboard",
            lastPostedAtUtc: now,
            lastRunAtUtc: now,
          });
        }
      } catch (err) {
        logger.error("Leaderboard webhook failed; not updating schedule state", err);
      }
    }
  }

  if (needActiveSnapshots && deps.saveState && !deps.dryRun) {
    const keep = new Set(snapshots.map((s) => s.pullRequestId));
    await pruneMissingSnapshots(tables.snapshots, team.id, keep);
    for (const snap of snapshots) {
      await upsertSnapshot(tables.snapshots, snap);
    }
  }
}

export interface ReviewHealthJobRunOptions {
  immediateLeaderboard: boolean;
  immediateReviewDebt: boolean;
  jobLabel: string;
  leaseRowKey: string;
  segments: ReadonlySet<ReviewHealthSegment>;
}

export async function runReviewHealthJobWithOptions(
  context: InvocationContext,
  options: ReviewHealthJobRunOptions,
): Promise<void> {
  const dryRun = envBool("DRY_RUN", false);
  const saveState = dryRun ? envBool("DRY_RUN_SAVE_STATE", false) : true;

  const connection = requireEnv("AzureWebJobsStorage");
  const snapshotsTable = requireEnv("PR_BOT_TABLE_NAME");
  const subs = requireEnv("PR_BOT_SUBSCRIPTIONS_TABLE_NAME");
  const schedule = requireEnv("PR_BOT_SCHEDULE_STATE_TABLE_NAME");
  const notifications = requireEnv("PR_BOT_NOTIFICATION_STATE_TABLE_NAME");

  const tables = await createTableClients(connection, {
    snapshots: snapshotsTable,
    subscriptions: subs,
    schedule,
    notifications,
  });

  const owner = context.invocationId ?? context.functionName ?? options.jobLabel;
  const acquired = await tryAcquireTimerLease(tables.leaseClient, 8 * 60_000, owner, options.leaseRowKey);
  if (!acquired) {
    logger.info(`Another execution holds lease ${options.leaseRowKey}; exiting (${options.jobLabel}).`);
    return;
  }

  logger.info(`Lease acquired (${options.jobLabel}); processing teams.`);

  try {
    const config = await loadAppConfig();
    for (const team of config.teams) {
      try {
        logger.info(`Processing team: ${team.id} [${options.jobLabel}]`);
        await processTeam(team, tables, {
          dryRun,
          saveState,
          segments: options.segments,
          immediateReviewDebt: options.immediateReviewDebt,
          immediateLeaderboard: options.immediateLeaderboard,
        });
      } catch (err) {
        logger.error(`Team processing failed: ${team.id}`, err);
      }
    }
  } finally {
    await releaseTimerLease(tables.leaseClient, options.leaseRowKey);
  }
}

function logConcurrencyLine(): void {
  const prConc = envPositiveInt("PR_SNAPSHOT_CONCURRENCY", 8, 32);
  logger.info(
    `ADO concurrency: PR_SNAPSHOT_CONCURRENCY=${prConc}, LEADERBOARD_ADO_CONCURRENCY=${envPositiveInt("LEADERBOARD_ADO_CONCURRENCY", prConc, 32)}`,
  );
}

/** Daily Review Debt Slack summary only — active PR snapshots + channel post when due. */
export async function runDailyReviewDebtJob(context: InvocationContext): Promise<void> {
  const immediate =
    envBool("IMMEDIATE_DAILY_REVIEW_DEBT", false) || envBool("IMMEDIATE_SCHEDULE_SUMMARIES", false);
  if (immediate) {
    logger.warn("Immediate daily review-debt posts enabled for this invocation (testing only)");
  }
  logConcurrencyLine();
  await runReviewHealthJobWithOptions(context, {
    jobLabel: "daily-review-debt",
    leaseRowKey: leaseKeyForSegment("review-debt"),
    segments: new Set<ReviewHealthSegment>(["review-debt"]),
    immediateReviewDebt: immediate,
    immediateLeaderboard: false,
  });
}

/** Weekly leaderboard — completed PR insights only when due (no active PR snapshot fetch). */
export async function runWeeklyLeaderboardJob(context: InvocationContext): Promise<void> {
  const immediate =
    envBool("IMMEDIATE_WEEKLY_LEADERBOARD", false) || envBool("IMMEDIATE_SCHEDULE_SUMMARIES", false);
  if (immediate) {
    logger.warn("Immediate weekly leaderboard posts enabled for this invocation (testing only)");
  }
  logConcurrencyLine();
  await runReviewHealthJobWithOptions(context, {
    jobLabel: "weekly-leaderboard",
    leaseRowKey: leaseKeyForSegment("leaderboard"),
    segments: new Set<ReviewHealthSegment>(["leaderboard"]),
    immediateReviewDebt: false,
    immediateLeaderboard: immediate,
  });
}

/** Subscriptions — auto-save subscription rows + DMs when events change (active PR snapshots). */
export async function runPersonalSubscriptionsJob(context: InvocationContext): Promise<void> {
  logConcurrencyLine();
  await runReviewHealthJobWithOptions(context, {
    jobLabel: "personal-subscriptions",
    leaseRowKey: leaseKeyForSegment("subscriptions"),
    segments: new Set<ReviewHealthSegment>(["subscriptions"]),
    immediateReviewDebt: false,
    immediateLeaderboard: false,
  });
}
