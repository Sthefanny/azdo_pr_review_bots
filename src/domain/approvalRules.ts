import type { PolicyConfiguration } from "../clients/azureDevOpsClient.js";
import type { ReviewerRecord } from "../models/snapshotTypes.js";
import { voteIsApproved } from "../models/snapshotTypes.js";

/** Minimum number of reviewers policy type id (Azure DevOps). */
export const MIN_REVIEWERS_POLICY_ID = "fa4e907d-ce8f-4863-acd7-063a55d95336";

export interface RequiredApprovalSummary {
  /** Machine-readable hints based on branch policies (best effort). */
  minimumRequiredReviewerCount: number;
  /** Outstanding identities when derivable (descriptor unique names). */
  missingDescriptors: string[];
}

export function summarizeRequiredApprovals(
  policies: PolicyConfiguration[],
  reviewers: ReviewerRecord[],
): RequiredApprovalSummary {
  const active = policies.filter((p) => p.isEnabled !== false);
  let minimumRequiredReviewerCount = 0;

  for (const policy of active) {
    const typeId = String(policy.type?.id ?? "");
    if (typeId !== MIN_REVIEWERS_POLICY_ID) continue;

    const settings = policy.settings ?? {};
    const min = Number(
      (settings as { minimumNumberOfReviewers?: unknown }).minimumNumberOfReviewers ?? 0,
    );
    if (Number.isFinite(min) && min > 0) {
      minimumRequiredReviewerCount = Math.max(minimumRequiredReviewerCount, min);
    }
  }

  const approvedVotes = reviewers.filter((r) => voteIsApproved(r.vote));
  const missingDescriptors: string[] = [];

  if (
    minimumRequiredReviewerCount > 0 &&
    approvedVotes.length < minimumRequiredReviewerCount
  ) {
    missingDescriptors.push("additional_required_approvals");
  }

  return { minimumRequiredReviewerCount, missingDescriptors };
}

export function isWaitingForAdditionalApprovals(summary: RequiredApprovalSummary): boolean {
  return (summary.missingDescriptors?.length ?? 0) > 0;
}
