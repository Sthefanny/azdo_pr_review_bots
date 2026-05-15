import type { AdoPullRequest, AzureDevOpsClient, ThreadEntity } from "../clients/azureDevOpsClient.js";
import type { TeamConfig } from "../config/configSchema.js";
import type { LeaderboardMetrics, LeaderboardReviewerRow } from "../models/domainTypes.js";
import { mapVote, voteIsApproved } from "../models/snapshotTypes.js";
import { isQodoBotIdentity } from "./botIdentities.js";
import { diffMinutesApprox } from "./businessTime.js";
import { extractCommentAuthors } from "./commentsAnalyzer.js";

import { mapConcurrent } from "../utils/mapConcurrent.js";

function normalizeEmail(value?: string | null): string | null {
  if (!value) return null;
  const t = value.trim().toLowerCase();
  return t.includes("@") ? t : null;
}

export interface LeaderboardPrInsight {
  pullRequestId: number;
  title: string;
  authorEmail: string | null;
  mergedAt: Date | null;
  createdAt: Date;
  detail: AdoPullRequest;
  threads: ThreadEntity[];
  firstReviewAt: Date | null;
  firstReviewerEmail: string | null;
  approvalAt: Date | null;
}

/** Pull ADO data for leaderboard aggregation (network-heavy). */
export async function collectLeaderboardInsights(
  client: AzureDevOpsClient,
  team: TeamConfig,
  completed: AdoPullRequest[],
  options?: { concurrency?: number },
): Promise<LeaderboardPrInsight[]> {
  const ignored = new Set(team.leaderboard.ignoredUsers.map((e) => e.toLowerCase()));
  const concurrency = Math.max(1, Math.min(32, options?.concurrency ?? 6));

  const rows = await mapConcurrent(completed, concurrency, async (pr) => {
    const [threads, detail] = await Promise.all([
      client.getThreads(pr.pullRequestId),
      client.getPullRequest(pr.pullRequestId),
    ]);
    const authorEmail = normalizeEmail(detail.createdBy?.uniqueName);
    if (authorEmail && ignored.has(authorEmail)) return null;

    let firstReview: Date | null = null;
    let firstReviewerEmail: string | null = null;
    let approvalAt: Date | null = null;
    const author = authorEmail ?? "";

    for (const thread of threads) {
      for (const comment of thread.comments ?? []) {
        if (String(comment.commentType ?? "").toLowerCase() === "system") continue;
        const who = normalizeEmail((comment as { author?: { uniqueName?: string; displayName?: string } }).author?.uniqueName);
        const ref = (comment as { author?: { uniqueName?: string; displayName?: string } }).author;
        if (
          isQodoBotIdentity({
            displayName: ref?.displayName,
            uniqueName: ref?.uniqueName,
          })
        ) {
          continue;
        }
        if (!who || who === author) continue;
        const pubRaw = (comment as { publishedDate?: string }).publishedDate;
        const pub = pubRaw ? Date.parse(pubRaw) : NaN;
        if (Number.isNaN(pub)) continue;
        const dt = new Date(pub);
        if (!firstReview || dt < firstReview) {
          firstReview = dt;
          firstReviewerEmail = who;
        }
        const content = String((comment as { content?: string }).content ?? "").toLowerCase();
        if (content.includes("approved") || content.includes("suggested")) {
          if (!approvalAt || dt < approvalAt) approvalAt = dt;
        }
      }
    }

    const insight: LeaderboardPrInsight = {
      pullRequestId: pr.pullRequestId,
      title: pr.title,
      authorEmail,
      mergedAt: pr.closedDate ? new Date(pr.closedDate) : null,
      createdAt: pr.creationDate ? new Date(pr.creationDate) : new Date(),
      detail,
      threads,
      firstReviewAt: firstReview,
      firstReviewerEmail,
      approvalAt,
    };
    return insight;
  });

  return rows.filter((x): x is LeaderboardPrInsight => x !== null);
}

function participatedEmails(
  insight: LeaderboardPrInsight,
  ignored: Set<string>,
): Map<string, { display: string }> {
  const author = insight.authorEmail ?? "";
  const map = new Map<string, { display: string }>();

  for (const r of insight.detail.reviewers ?? []) {
    if (
      isQodoBotIdentity({
        displayName: r.displayName,
        uniqueName: r.uniqueName,
      })
    ) {
      continue;
    }
    const email = normalizeEmail(r.uniqueName);
    if (!email || email === author || ignored.has(email)) continue;
    const voteKind = mapVote(r.vote ?? 0);
    if (voteKind !== "none") {
      map.set(email, { display: r.displayName ?? email });
    }
  }

  for (const email of extractCommentAuthors(insight.threads)) {
    if (!email || email === author || ignored.has(email)) continue;
    if (!map.has(email)) {
      map.set(email, { display: email.split("@")[0] ?? email });
    }
  }

  return map;
}

export function calculateLeaderboard(
  insights: LeaderboardPrInsight[],
  team: TeamConfig,
): LeaderboardMetrics {
  const ignored = new Set(team.leaderboard.ignoredUsers.map((e) => e.toLowerCase()));

  type Acc = {
    display: string;
    reviewed: Set<number>;
    approvals: number;
    comments: number;
  };

  const stats = new Map<string, Acc>();

  for (const insight of insights) {
    const participants = participatedEmails(insight, ignored);

    for (const [email, meta] of participants) {
      let acc = stats.get(email);
      if (!acc) acc = { display: meta.display, reviewed: new Set(), approvals: 0, comments: 0 };
      acc.reviewed.add(insight.pullRequestId);
      stats.set(email, acc);
    }

    const author = insight.authorEmail ?? "";
    for (const r of insight.detail.reviewers ?? []) {
      if (
        isQodoBotIdentity({
          displayName: r.displayName,
          uniqueName: r.uniqueName,
        })
      ) {
        continue;
      }
      const email = normalizeEmail(r.uniqueName);
      if (!email || email === author || ignored.has(email)) continue;
      if (!voteIsApproved(mapVote(r.vote ?? 0))) continue;
      const acc = stats.get(email);
      if (acc) acc.approvals += 1;
    }

    for (const [email] of participants) {
      const acc = stats.get(email);
      if (!acc) continue;
      let count = 0;
      for (const thread of insight.threads) {
        for (const comment of thread.comments ?? []) {
          const who = normalizeEmail((comment as { author?: { uniqueName?: string } }).author?.uniqueName);
          if (who === email) count += 1;
        }
      }
      acc.comments += count;
    }
  }

  const rows: LeaderboardReviewerRow[] = [...stats.entries()].map(([email, acc]) => ({
    displayName: acc.display,
    email,
    reviewedPullRequestCount: acc.reviewed.size,
    approvalsCount: acc.approvals,
    commentsCount: acc.comments,
  }));

  rows.sort((a, b) => b.reviewedPullRequestCount - a.reviewedPullRequestCount);
  const limit = team.leaderboard.showTopReviewers;
  const top = limit > 0 ? rows.slice(0, limit) : [];

  const firstSamples: number[] = [];
  const mergeSamples: number[] = [];
  for (const i of insights) {
    if (i.firstReviewAt) {
      const m = diffMinutesApprox(i.createdAt, i.firstReviewAt);
      if (m !== null && m >= 0) firstSamples.push(m);
    }
    if (i.mergedAt && i.approvalAt) {
      const m = diffMinutesApprox(i.approvalAt, i.mergedAt);
      if (m !== null && m >= 0) mergeSamples.push(m);
    }
  }

  const avg = (xs: number[]): number | null =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

  let fastest: { name: string; minutes: number } | null = null;
  for (const i of insights) {
    if (!i.firstReviewAt || !i.firstReviewerEmail) continue;
    const m = diffMinutesApprox(i.createdAt, i.firstReviewAt);
    if (m === null || m <= 0) continue;
    const display =
      stats.get(i.firstReviewerEmail)?.display ?? i.firstReviewerEmail.split("@")[0] ?? i.firstReviewerEmail;
    if (!fastest || m < fastest.minutes) {
      fastest = { name: display, minutes: m };
    }
  }

  let mostComments: { name: string; count: number } | null = null;
  let mostApprovals: { name: string; count: number } | null = null;
  for (const r of rows) {
    if (r.commentsCount > 0 && (!mostComments || r.commentsCount > mostComments.count)) {
      mostComments = { name: r.displayName, count: r.commentsCount };
    }
    if (r.approvalsCount > 0 && (!mostApprovals || r.approvalsCount > mostApprovals.count)) {
      mostApprovals = { name: r.displayName, count: r.approvalsCount };
    }
  }

  const prsTouched = new Set<number>();
  for (const insight of insights) {
    if (participatedEmails(insight, ignored).size > 0) {
      prsTouched.add(insight.pullRequestId);
    }
  }
  const prsReviewedTotal = prsTouched.size;

  return {
    topReviewers: top,
    prsReviewedTotal,
    prsMergedTotal: insights.length,
    avgFirstReviewMinutes: avg(firstSamples),
    avgReadyToMergeMinutes: avg(mergeSamples),
    specials: {
      fastestFirstReviewReviewer: fastest,
      mostCommentsReviewer: mostComments,
      mostApprovalsReviewer: mostApprovals,
    },
  };
}
