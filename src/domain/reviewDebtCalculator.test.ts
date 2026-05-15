import { describe, expect, it } from "vitest";

import type { TeamConfig } from "../config/configSchema.js";
import type { PullRequestSnapshot } from "../models/domainTypes.js";
import { calculateReviewDebtMetrics, isWaitingForHumanReview } from "./reviewDebtCalculator.js";

const team: TeamConfig = {
  id: "t1",
  enabled: true,
  displayName: "Team",
  azureDevOps: {
    organization: "o",
    project: "p",
    repositoryId: "r",
    patEnvVar: "PAT",
    useReadyForReviewLabel: false,
    readyForReviewLabel: "Ready for Review",
  },
  slack: {
    webhookEnvVar: "WH",
    botTokenEnvVar: "BT",
    userMapping: {},
  },
  businessDays: {
    timezone: "UTC",
    weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  },
  reviewDebt: {
    enabled: true,
    schedule: "0 0 9 * * *",
    slaBusinessDays: [1, 2],
    includeNeedsAttention: true,
    maxNeedsAttentionItems: 5,
    includeBlockedByChecks: true,
    includeUnresolvedComments: true,
    includeWaitingForLeadApproval: true,
    metricsLookbackDays: 7,
  },
  leaderboard: {
    enabled: true,
    schedule: "0 0 10 * * 5",
    lookbackDays: 7,
    showTopReviewers: 3,
    countApprovals: true,
    countComments: true,
    showTeamStats: true,
    showSpecialThanks: true,
    avoidNegativeRanking: true,
    ignoredUsers: [],
  },
  subscriptions: {
    enabled: true,
    autoSubscribeAuthors: true,
    autoSubscribeReviewers: true,
    autoSubscribeCommenters: true,
    allowManualSubscribe: false,
    notifyOn: {
      newComments: true,
      resolvedComments: true,
      buildFailed: true,
      buildSucceededAfterFailure: true,
      approvalChanged: true,
      mergeConflicts: true,
      prMerged: true,
      prAbandoned: true,
      newPushAfterReview: true,
    },
    dmRules: {
      buildFailedAuthorOnly: true,
      mergeConflictAuthorOnly: true,
      skipActor: true,
    },
  },
  checks: {
    enabled: true,
    ignoredChecks: [],
    relevantChecks: [],
  },
};

describe("reviewDebtCalculator", () => {
  it("detects waiting for reviewer vote (no non-none ADO vote)", () => {
    const snap: PullRequestSnapshot = {
      teamId: "t1",
      pullRequestId: 1,
      title: "x",
      authorName: "a",
      authorEmail: "a@example.com",
      sourceBranch: "f",
      targetBranch: "main",
      status: "active",
      isDraft: false,
      labels: [],
      createdAtUtc: new Date(),
      closedAtUtc: null,
      reviewers: [],
      approvalsByDescriptor: [],
      unresolvedCommentThreads: 0,
      threadSummariesHash: "h",
      threadsJson: "{}",
  checksEnabled: true,
  checksSummary: undefined,
  checksJson: "[]",
      failedRelevantChecks: [],
      mergeConflict: false,
      lastSourceCommitId: null,
      lastKnownIterationId: null,
      lastReviewCommitId: null,
      requiredApprovalsJson: "{}",
      missingRequiredApprovalsJson: "{}",
      lastSeenAtUtc: new Date(),
      lastUpdatedAtUtc: new Date(),
      snapshotHash: "x",
    };
    expect(isWaitingForHumanReview(snap)).toBe(true);
    const metrics = calculateReviewDebtMetrics([snap], team, new Date());
    expect(metrics.openWaitingReview).toBeGreaterThan(0);
  });
});
