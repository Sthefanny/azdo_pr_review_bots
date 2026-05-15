import type {
    AdoPullRequest,
    AzureDevOpsClient,
    PolicyConfiguration,
} from "../clients/azureDevOpsClient.js";
import type { TeamConfig } from "../config/configSchema.js";
import type { PrStatus, PullRequestSnapshot } from "../models/domainTypes.js";
import type { ApprovalRecord, ReviewerRecord } from "../models/snapshotTypes.js";
import { mapVote, voteIsApproved } from "../models/snapshotTypes.js";
import { utcNow } from "../utils/dateTime.js";
import { fnv1aHex } from "../utils/hash.js";
import { summarizeRequiredApprovals } from "./approvalRules.js";
import { isQodoBotIdentity } from "./botIdentities.js";
import { normalizeChecks } from "./checksAnalyzer.js";
import { summarizeThreads } from "./commentsAnalyzer.js";

function emailFromUniqueName(uniqueName?: string): string | null {
  if (!uniqueName) return null;
  const trimmed = uniqueName.trim();
  if (!trimmed.includes("@")) return null;
  return trimmed.toLowerCase();
}

function mapPrStatus(status?: string): PrStatus {
  const s = String(status ?? "").toLowerCase();
  if (s === "completed") return "completed";
  if (s === "abandoned") return "abandoned";
  return "active";
}

export function prIncludedByLabel(
  pr: AdoPullRequest,
  team: TeamConfig["azureDevOps"],
): boolean {
  if (!team.useReadyForReviewLabel) return true;
  const target = team.readyForReviewLabel.toLowerCase();
  const labels = pr.labels?.map((l) => String(l.name ?? "").toLowerCase()) ?? [];
  return labels.includes(target);
}

function deriveReviewers(pr: AdoPullRequest): ReviewerRecord[] {
  const list = pr.reviewers ?? [];
  return list
    .filter(
      (r) =>
        !isQodoBotIdentity({
          displayName: r.displayName,
          uniqueName: r.uniqueName,
        }),
    )
    .map((r) => {
      const vote = mapVote(r.vote ?? 0);
      return {
        displayName: r.displayName ?? r.uniqueName ?? "unknown",
        descriptor: String(r.id ?? r.uniqueName ?? r.displayName ?? ""),
        vote,
        uniqueName: r.uniqueName,
      };
    });
}

function deriveApprovals(reviewers: ReviewerRecord[]): ApprovalRecord[] {
  return reviewers
    .filter((r) => voteIsApproved(r.vote))
    .map((r) => ({
      reviewerDescriptor: r.descriptor,
      voteTimeUtc: null,
    }));
}

function mergeConflictFromPr(pr: AdoPullRequest): boolean {
  const status = String(pr.mergeStatus ?? "").toLowerCase();
  return status.includes("conflict");
}

async function resolveBranchPolicies(
  team: TeamConfig,
  client: AzureDevOpsClient,
  branchPolicyLoadCache: Map<string, Promise<PolicyConfiguration[]>> | undefined,
  targetRefName: string,
): Promise<PolicyConfiguration[]> {
  if (!team.reviewDebt.includeWaitingForLeadApproval) return [];
  if (!branchPolicyLoadCache) {
    return client.loadBranchPolicies({
      repositoryId: team.azureDevOps.repositoryId,
      refName: targetRefName,
    });
  }
  let pending = branchPolicyLoadCache.get(targetRefName);
  if (!pending) {
    pending = client.loadBranchPolicies({
      repositoryId: team.azureDevOps.repositoryId,
      refName: targetRefName,
    });
    branchPolicyLoadCache.set(targetRefName, pending);
  }
  return pending;
}

export async function buildPullRequestSnapshot(params: {
  branchPolicyLoadCache?: Map<string, Promise<PolicyConfiguration[]>> | undefined;
  team: TeamConfig;
  teamId: string;
  client: AzureDevOpsClient;
  pullRequestId: number;
  previous?: PullRequestSnapshot | null;
  threadsRaw: import("../clients/azureDevOpsClient.js").ThreadEntity[];
}): Promise<PullRequestSnapshot> {
  const { team, teamId, client, pullRequestId, previous, branchPolicyLoadCache } = params;
  const pr = await client.getPullRequest(pullRequestId);

  const refName = pr.targetRefName ?? "";
  const [statuses, iterations, policies] = await Promise.all([
    client.listStatuses(pullRequestId),
    client.getIterations(pullRequestId),
    resolveBranchPolicies(team, client, branchPolicyLoadCache, refName),
  ]);

  const reviewers = deriveReviewers(pr);
  const threadSum = summarizeThreads(params.threadsRaw);
  const checks = normalizeChecks(statuses, team.checks);
  const approvalSummary = summarizeRequiredApprovals(policies, reviewers);

  const authorEmail = emailFromUniqueName(pr.createdBy?.uniqueName);
  const labels = pr.labels?.map((l) => String(l.name ?? "")) ?? [];

  const lastIterationId =
    iterations.length > 0 ? Math.max(...iterations.map((i) => i.id)) : null;

  const commitId = pr.lastMergeSourceCommit?.commitId ?? null;

  const firstReviewFromThreads = earliestNonAuthorCommentUtc(
    pr,
    params.threadsRaw,
  );
  const firstApprovalGuess = earliestApprovalEventUtc(params.threadsRaw, pr);

  const now = utcNow();

  let lastReviewCommitId = previous?.lastReviewCommitId ?? null;
  const hadReviewerActivity = reviewers.some((r) => r.vote !== "none");
  if (hadReviewerActivity && commitId) {
    lastReviewCommitId = commitId;
  }

  const snapshot: PullRequestSnapshot = {
    teamId,
    pullRequestId,
    title: pr.title,
    authorName: pr.createdBy?.displayName ?? "unknown",
    authorEmail,
    authorDescriptor: pr.createdBy?.descriptor ?? pr.createdBy?.id ?? null,
    sourceBranch: stripRefsHeads(pr.sourceRefName ?? ""),
    targetBranch: stripRefsHeads(pr.targetRefName ?? ""),
    targetRefName: pr.targetRefName ?? "",
    status: mapPrStatus(pr.status),
    isDraft: Boolean(pr.isDraft),
    labels,
    createdAtUtc: pr.creationDate ? new Date(pr.creationDate) : now,
    closedAtUtc: pr.closedDate ? new Date(pr.closedDate) : null,
    reviewers,
    approvalsByDescriptor: deriveApprovals(reviewers),
    unresolvedCommentThreads: threadSum.unresolvedCount,
    threadSummariesHash: threadSum.hash,
    threadsJson: threadSum.threadsJson,
    checksEnabled: team.checks.enabled,
    checksSummary: checks.relevant,
    checksJson: JSON.stringify(checks.relevant),
    failedRelevantChecks: checks.failedRelevantNames,
    mergeConflict: mergeConflictFromPr(pr),
    lastSourceCommitId: commitId,
    lastKnownIterationId: lastIterationId,
    lastReviewCommitId,
    requiredApprovalsJson: JSON.stringify(approvalSummary),
    missingRequiredApprovalsJson: JSON.stringify({
      missing: approvalSummary.missingDescriptors,
      minimum: approvalSummary.minimumRequiredReviewerCount,
    }),
    lastSeenAtUtc: now,
    lastUpdatedAtUtc: now,
    snapshotHash: "",
    firstReviewAtUtc:
      previous?.firstReviewAtUtc ??
      firstReviewFromThreads ??
      null,
    firstApprovalAtUtc:
      previous?.firstApprovalAtUtc ?? firstApprovalGuess ?? null,
  };

  if (!snapshot.firstReviewAtUtc && firstReviewFromThreads) {
    snapshot.firstReviewAtUtc = firstReviewFromThreads;
  }
  if (
    !snapshot.firstApprovalAtUtc &&
    reviewers.some((r) => voteIsApproved(r.vote))
  ) {
    snapshot.firstApprovalAtUtc = firstApprovalGuess ?? now;
  }

  snapshot.snapshotHash = fnv1aHex(
    JSON.stringify({
      votes: reviewers.map((r) => [r.descriptor, r.vote]),
      commitId,
      threads: threadSum.hash,
      checks: checks.failedRelevantNames,
      merge: snapshot.mergeConflict,
      unresolved: threadSum.unresolvedCount,
    }),
  );

  return snapshot;
}

export function stripRefsHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//i, "");
}

function earliestNonAuthorCommentUtc(
  pr: AdoPullRequest,
  threads: import("../clients/azureDevOpsClient.js").ThreadEntity[],
): Date | null {
  const author = emailFromUniqueName(pr.createdBy?.uniqueName)?.toLowerCase() ?? "";
  let best: number | null = null;
  for (const thread of threads) {
    for (const comment of thread.comments ?? []) {
      if (String(comment.commentType ?? "").toLowerCase() === "system") continue;
      const ref = (comment as { author?: { uniqueName?: string; displayName?: string } }).author;
      if (
        isQodoBotIdentity({
          displayName: ref?.displayName,
          uniqueName: ref?.uniqueName,
        })
      ) {
        continue;
      }
      const who = ref?.uniqueName;
      const email = emailFromUniqueName(who)?.toLowerCase() ?? "";
      if (!email || email === author) continue;
      const pub = (comment as { publishedDate?: string }).publishedDate;
      if (!pub) continue;
      const ms = Date.parse(pub);
      if (Number.isNaN(ms)) continue;
      if (best === null || ms < best) best = ms;
    }
  }
  return best === null ? null : new Date(best);
}

/** Heuristic: find comment that looks like “voted Approved”. */
function earliestApprovalEventUtc(
  threads: import("../clients/azureDevOpsClient.js").ThreadEntity[],
  pr: AdoPullRequest,
): Date | null {
  const author = emailFromUniqueName(pr.createdBy?.uniqueName)?.toLowerCase() ?? "";
  let best: number | null = null;
  for (const thread of threads) {
    for (const comment of thread.comments ?? []) {
      if (String(comment.commentType ?? "").toLowerCase() === "system") continue;
      const content = String((comment as { content?: string }).content ?? "").toLowerCase();
      const ref = (comment as { author?: { uniqueName?: string; displayName?: string } }).author;
      if (
        isQodoBotIdentity({
          displayName: ref?.displayName,
          uniqueName: ref?.uniqueName,
        })
      ) {
        continue;
      }
      const who = ref?.uniqueName;
      const email = emailFromUniqueName(who)?.toLowerCase() ?? "";
      if (!email || email === author) continue;
      if (
        !(
          content.includes("approved") ||
          content.includes("suggested") ||
          content.includes("vote:")
        )
      ) {
        continue;
      }
      const pub = (comment as { publishedDate?: string }).publishedDate;
      if (!pub) continue;
      const ms = Date.parse(pub);
      if (Number.isNaN(ms)) continue;
      if (best === null || ms < best) best = ms;
    }
  }
  return best === null ? null : new Date(best);
}