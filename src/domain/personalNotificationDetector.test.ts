import { describe, expect, it } from "vitest";

import type { TeamConfig } from "../config/configSchema.js";
import type { PullRequestSnapshot } from "../models/domainTypes.js";
import { detectPersonalNotificationEvents } from "./personalNotificationDetector.js";

const baseTeam: TeamConfig = {
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
    slaBusinessDays: [1],
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
    relevantChecks: ["Check"],
  },
};

function snap(partial: Partial<PullRequestSnapshot>): PullRequestSnapshot {
  return {
    teamId: "t1",
    pullRequestId: 9,
    title: "PR",
    authorName: "a",
    authorEmail: "a@example.com",
    sourceBranch: "f",
    targetBranch: "m",
    status: "active",
    isDraft: false,
    labels: [],
    createdAtUtc: new Date(),
    closedAtUtc: null,
    reviewers: [],
    approvalsByDescriptor: [],
    unresolvedCommentThreads: 0,
    threadSummariesHash: "1",
    threadsJson: JSON.stringify({ summaries: [] }),
    checksEnabled: true,
    checksSummary: undefined,
    checksJson: "[]",
    failedRelevantChecks: [],
    mergeConflict: false,
    lastSourceCommitId: "abc",
    lastKnownIterationId: 1,
    lastReviewCommitId: null,
    requiredApprovalsJson: "{}",
    missingRequiredApprovalsJson: "{}",
    lastSeenAtUtc: new Date(),
    lastUpdatedAtUtc: new Date(),
    snapshotHash: "s",
    ...partial,
  };
}

describe("personalNotificationDetector", () => {
  it("emits merge conflict transition", () => {
    const prev = snap({ mergeConflict: false });
    const curr = snap({ mergeConflict: true });
    const events = detectPersonalNotificationEvents({
      team: baseTeam,
      previous: prev,
      current: curr,
      prUrl: "https://example.com/pr/9",
    });
    expect(events.some((e) => e.type === "merge_conflict")).toBe(true);
  });
});
