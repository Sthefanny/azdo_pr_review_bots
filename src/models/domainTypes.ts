/** Normalized normalized domain entities (serialized to Table Storage rows). */

import type {
    ApprovalRecord,
    CheckRunState,
    ReviewerRecord,
} from "./snapshotTypes.js";

export type PrStatus = "active" | "completed" | "abandoned";

export interface PullRequestSnapshot {
  teamId: string;
  pullRequestId: number;
  title: string;
  authorName: string;
  authorEmail: string | null;
  /** Azure DevOps user descriptor if present (for actor matching). */
  authorDescriptor?: string | null;
  sourceBranch: string;
  targetBranch: string;
  /** Fully qualified refs e.g. `refs/heads/main` */
  targetRefName?: string;
  status: PrStatus;
  isDraft: boolean;
  labels: string[];
  createdAtUtc: Date;
  closedAtUtc?: Date | null;

  reviewers: ReviewerRecord[];
  approvalsByDescriptor: ApprovalRecord[];

  unresolvedCommentThreads: number;
  threadSummariesHash: string;
  threadsJson: string;

  checksEnabled: boolean;
  checksSummary: unknown;
  /** JSON string persisted in table */
  checksJson: string;
  failedRelevantChecks: string[];

  mergeConflict: boolean;
  lastSourceCommitId: string | null;
  lastKnownIterationId: number | null;

  /** Used for “push after review” detection */
  lastReviewCommitId: string | null;

  requiredApprovalsJson: string;
  missingRequiredApprovalsJson: string;

  lastSeenAtUtc: Date;
  lastUpdatedAtUtc: Date;

  snapshotHash: string;

  /** First review timestamps derived from snapshots / timelines (stored for metrics). */
  firstReviewAtUtc?: Date | null;
  firstApprovalAtUtc?: Date | null;
}

export type SubscriptionType = "author" | "reviewer" | "commenter" | "manual";

export interface Subscription {
  teamId: string;
  pullRequestId: number;
  slackUserId: string;
  azureDevOpsEmail: string | null;
  subscriptionType: SubscriptionType;
  createdAtUtc: Date;
  updatedAtUtc: Date;
  isActive: boolean;
}

export type ScheduleName = "daily-review-debt" | "weekly-leaderboard";

export interface ScheduleState {
  teamId: string;
  scheduleName: ScheduleName;
  lastPostedAtUtc: Date | null;
  lastRunAtUtc: Date | null;
}

export type PersonalNotificationEventType =
  | "new_comment"
  | "resolved_thread"
  | "build_failed"
  | "build_recovered"
  | "approval_changed"
  | "merge_conflict"
  | "pr_merged"
  | "pr_abandoned"
  | "new_push_after_review";

export interface NotificationState {
  teamId: string;
  pullRequestId: number;
  eventType: PersonalNotificationEventType;
  slackUserId: string;
  lastEventHash: string;
  lastNotifiedAtUtc: Date;
}

export interface PullRequestDebtRow {
  pr: PullRequestSnapshot;
  blockedByChecks: boolean;
  blockedByUnresolved: boolean;
  waitingForLeadApproval?: boolean;
  missingFirstReview: boolean;
  businessDaysSinceReady: number;
}

export interface ReviewDebtMetrics {
  openWaitingReview: number;
  waitingFirstGtSla: Map<number, number>;
  oldestWaitingMinutes: number | null;
  avgTimeToFirstReviewMinutesWeek: number | null;
  avgReadyToApprovalMinutesWeek: number | null;
  blockedChecks: PullRequestDebtRow[];
  blockedUnresolved: PullRequestDebtRow[];
  slaNeedsAttention: PullRequestDebtRow[];
}

export interface LeaderboardReviewerRow {
  displayName: string;
  /** Primary email from ADO identities when known */
  email: string | null;
  reviewedPullRequestCount: number;
  approvalsCount: number;
  commentsCount: number;
}

export interface LeaderboardSpecialThanks {
  fastestFirstReviewReviewer: { name: string; minutes: number } | null;
  mostCommentsReviewer: { name: string; count: number } | null;
  mostApprovalsReviewer: { name: string; count: number } | null;
}

export interface LeaderboardMetrics {
  topReviewers: LeaderboardReviewerRow[];
  prsReviewedTotal: number;
  prsMergedTotal: number;
  avgFirstReviewMinutes: number | null;
  avgReadyToMergeMinutes: number | null;
  specials: LeaderboardSpecialThanks;
}

export interface PersonalNotificationEvent {
  type: PersonalNotificationEventType;
  prId: number;
  title: string;
  /** Slack mrkdwn text */
  text: string;
  /** Target Slack user IDs */
  userIds: string[];
  dedupeParts: Record<string, string | undefined>;
  /** When true, only the PR author should be notified. */
  authorOnly?: boolean | undefined;
}

export interface CheckStatusNormalized {
  name: string;
  state: CheckRunState;
  description?: string;
}
