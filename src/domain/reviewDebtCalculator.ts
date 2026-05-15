import type { TeamConfig } from "../config/configSchema.js";
import type {
    PullRequestDebtRow,
    PullRequestSnapshot,
    ReviewDebtMetrics,
} from "../models/domainTypes.js";
import { isWaitingForAdditionalApprovals, type RequiredApprovalSummary } from "./approvalRules.js";
import {
    countBusinessCalendarDaysBetween,
    diffMinutesApprox,
} from "./businessTime.js";

function parseApprovalSummary(json: string): RequiredApprovalSummary {
  try {
    const parsed = JSON.parse(json) as Partial<RequiredApprovalSummary>;
    return {
      minimumRequiredReviewerCount: Number(parsed.minimumRequiredReviewerCount ?? 0),
      missingDescriptors: Array.isArray(parsed.missingDescriptors)
        ? parsed.missingDescriptors
        : [],
    };
  } catch {
    return { minimumRequiredReviewerCount: 0, missingDescriptors: [] };
  }
}

function parseMissingBlock(json: string): string[] {
  try {
    const payload = JSON.parse(json) as { missing?: string[] };
    return Array.isArray(payload.missing) ? payload.missing : [];
  } catch {
    return [];
  }
}

export function hasFirstReview(
  reviewers: PullRequestSnapshot["reviewers"],
  authorEmail: string | null,
): boolean {
  const author = authorEmail?.toLowerCase() ?? "";
  return reviewers.some((r) => {
    const reviewerEmail = (r.uniqueName ?? "")
      .trim()
      .toLowerCase();
    if (reviewerEmail.includes("@") && reviewerEmail === author) return false;
    return r.vote !== "none";
  });
}

export function isWaitingForHumanReview(snap: PullRequestSnapshot): boolean {
  if (snap.isDraft) return false;
  return !hasFirstReview(snap.reviewers, snap.authorEmail);
}

export function needsReviewAttention(
  snap: PullRequestSnapshot,
  team: TeamConfig,
): boolean {
  if (snap.isDraft || snap.status !== "active") return false;

  const missingFirst = isWaitingForHumanReview(snap);
  const blockedChecks =
    team.reviewDebt.includeBlockedByChecks &&
    team.checks.enabled &&
    snap.failedRelevantChecks.length > 0;
  const unresolved =
    team.reviewDebt.includeUnresolvedComments && snap.unresolvedCommentThreads > 0;
  const missingLead =
    team.reviewDebt.includeWaitingForLeadApproval &&
    (parseMissingBlock(snap.missingRequiredApprovalsJson).length > 0 ||
      isWaitingForAdditionalApprovals(parseApprovalSummary(snap.requiredApprovalsJson)));

  return missingFirst || blockedChecks || unresolved || missingLead;
}

export function buildDebtRowsForOpenPulls(
  pulls: PullRequestSnapshot[],
  team: TeamConfig,
  now: Date,
): PullRequestDebtRow[] {
  return pulls.map((pr) => {
    const summary = parseApprovalSummary(pr.requiredApprovalsJson);
    const waitingLead =
      team.reviewDebt.includeWaitingForLeadApproval &&
      isWaitingForAdditionalApprovals(summary);

    return {
      pr,
      blockedByChecks:
        team.reviewDebt.includeBlockedByChecks && pr.failedRelevantChecks.length > 0,
      blockedByUnresolved:
        team.reviewDebt.includeUnresolvedComments && pr.unresolvedCommentThreads > 0,
      waitingForLeadApproval:
        waitingLead || parseMissingBlock(pr.missingRequiredApprovalsJson).length > 0,
      missingFirstReview: isWaitingForHumanReview(pr),
      businessDaysSinceReady: countBusinessCalendarDaysBetween(
        pr.createdAtUtc,
        now,
        team.businessDays,
      ),
    };
  });
}

export function calculateReviewDebtMetrics(
  pulls: PullRequestSnapshot[],
  team: TeamConfig,
  now: Date,
): ReviewDebtMetrics {
  const inScope = pulls.filter((p) => !p.isDraft && p.status === "active");
  const waitingReview = inScope.filter((p) => needsReviewAttention(p, team));

  const slaMap = new Map<number, number>();
  const slaThresholds = [...team.reviewDebt.slaBusinessDays].sort((a, b) => a - b);
  for (const threshold of slaThresholds) {
    let count = 0;
    for (const p of inScope) {
      if (!isWaitingForHumanReview(p)) continue;
      if (
        countBusinessCalendarDaysBetween(p.createdAtUtc, now, team.businessDays) >=
        threshold
      ) {
        count += 1;
      }
    }
    slaMap.set(threshold, count);
  }

  let oldestMinutes: number | null = null;
  for (const p of inScope) {
    if (!isWaitingForHumanReview(p)) continue;
    const mins = diffMinutesApprox(p.createdAtUtc, now);
    if (mins === null) continue;
    if (oldestMinutes === null || mins > oldestMinutes) oldestMinutes = mins;
  }

  const metricsWindowStart = new Date(now);
  metricsWindowStart.setUTCDate(
    metricsWindowStart.getUTCDate() - team.reviewDebt.metricsLookbackDays,
  );

  const firstReviewSamples: number[] = [];
  const readyToApprovalSamples: number[] = [];

  for (const p of pulls) {
    if (!p.closedAtUtc || p.closedAtUtc < metricsWindowStart) continue;
    if (p.firstReviewAtUtc) {
      const diff = diffMinutesApprox(p.createdAtUtc, p.firstReviewAtUtc);
      if (diff !== null && diff >= 0) firstReviewSamples.push(diff);
    }
    if (p.firstApprovalAtUtc && p.closedAtUtc) {
      const diff = diffMinutesApprox(p.firstApprovalAtUtc, p.closedAtUtc);
      if (diff !== null && diff >= 0) readyToApprovalSamples.push(diff);
    }
  }

  const avg = (xs: number[]): number | null =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

  const debtRows = buildDebtRowsForOpenPulls(inScope, team, now);
  const maxSla = slaThresholds.length ? Math.max(...slaThresholds) : 2;
  const slaAttention = debtRows.filter(
    (row) => row.missingFirstReview && row.businessDaysSinceReady >= maxSla,
  );

  return {
    openWaitingReview: waitingReview.length,
    waitingFirstGtSla: slaMap,
    oldestWaitingMinutes: oldestMinutes,
    avgTimeToFirstReviewMinutesWeek: avg(firstReviewSamples),
    avgReadyToApprovalMinutesWeek: avg(readyToApprovalSamples),
    blockedChecks: debtRows.filter((d) => d.blockedByChecks),
    blockedUnresolved: debtRows.filter((d) => d.blockedByUnresolved),
    slaNeedsAttention: slaAttention,
  };
}
