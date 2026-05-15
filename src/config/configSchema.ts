/**
 * Validates and parses `config/config.json` after `${ENV_VAR}` substitution.
 */

import { z } from "zod";

export const WEEKDAY_SCHEMA = z.enum([
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]);

const azureDevOpsSchema = z.object({
  organization: z.string().min(1),
  project: z.string().min(1),
  repositoryId: z.string().min(1),
  repositoryName: z.string().min(1).optional(),
  patEnvVar: z.string().min(1),
  useReadyForReviewLabel: z.boolean().default(false),
  readyForReviewLabel: z.string().default("Ready for Review"),
  /**
   * Only load **active** PRs created within this many days (rolling, UTC).
   * Omit or unset for all active PRs (up to $top). Speeds up large repos for dev/test.
   */
  activePullRequestCreatedWithinDays: z.number().int().positive().max(365).optional(),
});

const slackSchema = z.object({
  webhookEnvVar: z.string().min(1),
  botTokenEnvVar: z.string().min(1),
  userMapping: z.record(z.string().email(), z.string().min(1)),
});

const businessDaysSchema = z.object({
  timezone: z.string().min(1).default("America/New_York"),
  weekdays: z.array(WEEKDAY_SCHEMA).min(1),
});

const reviewDebtSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: z.string().min(1),
  slaBusinessDays: z.array(z.number().int().positive()).min(1).default([1, 2]),
  includeNeedsAttention: z.boolean().default(true),
  maxNeedsAttentionItems: z.number().int().positive().max(50).default(10),
  includeBlockedByChecks: z.boolean().default(true),
  includeUnresolvedComments: z.boolean().default(true),
  includeWaitingForLeadApproval: z.boolean().default(true),
  /** Rolling window used for averages in daily summary when ADO metrics allow. */
  metricsLookbackDays: z.number().int().positive().max(31).default(7),
});

const leaderboardSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: z.string().min(1),
  lookbackDays: z.number().int().positive().max(60).default(7),
  showTopReviewers: z.number().int().min(0).max(20).default(5),
  countApprovals: z.boolean().default(true),
  countComments: z.boolean().default(true),
  showTeamStats: z.boolean().default(true),
  showSpecialThanks: z.boolean().default(true),
  avoidNegativeRanking: z.boolean().default(true),
  ignoredUsers: z.array(z.string().email()).default([]),
  /**
   * Env var name holding a Giphy API key. When set (and weekly post runs with a #1 reviewer),
   * the message includes a random celebration/thanks GIF for the winner.
   */
  giphyApiKeyEnvVar: z.string().min(1).optional(),
});

const subscriptionsNotifySchema = z.object({
  newComments: z.boolean().default(true),
  resolvedComments: z.boolean().default(true),
  buildFailed: z.boolean().default(true),
  buildSucceededAfterFailure: z.boolean().default(true),
  approvalChanged: z.boolean().default(true),
  mergeConflicts: z.boolean().default(true),
  prMerged: z.boolean().default(true),
  prAbandoned: z.boolean().default(true),
  newPushAfterReview: z.boolean().default(true),
});

const dmRulesSchema = z.object({
  buildFailedAuthorOnly: z.boolean().default(true),
  mergeConflictAuthorOnly: z.boolean().default(true),
  skipActor: z.boolean().default(true),
});

const subscriptionsSchema = z.object({
  enabled: z.boolean().default(true),
  autoSubscribeAuthors: z.boolean().default(true),
  autoSubscribeReviewers: z.boolean().default(true),
  autoSubscribeCommenters: z.boolean().default(true),
  allowManualSubscribe: z.boolean().default(false),
  notifyOn: subscriptionsNotifySchema,
  dmRules: dmRulesSchema,
});

const checksSchema = z.object({
  enabled: z.boolean().default(true),
  ignoredChecks: z.array(z.string()).default([]),
  relevantChecks: z.array(z.string()).default([]),
});

export const teamConfigSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  displayName: z.string().min(1),
  azureDevOps: azureDevOpsSchema,
  slack: slackSchema,
  businessDays: businessDaysSchema,
  reviewDebt: reviewDebtSchema,
  leaderboard: leaderboardSchema,
  subscriptions: subscriptionsSchema,
  checks: checksSchema,
});

export const appConfigSchema = z.object({
  teams: z.array(teamConfigSchema).min(1),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type TeamConfig = z.infer<typeof teamConfigSchema>;
