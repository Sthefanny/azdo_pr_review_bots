export type VoteKind =
  | "none"
  | "approved"
  | "approved_suggestions"
  | "waiting_author"
  | "rejected";

export interface ReviewerRecord {
  displayName: string;
  descriptor: string;
  vote: VoteKind;
  /** Azure DevOps `uniqueName` when it is an email. */
  uniqueName?: string | undefined;
}

export interface ApprovalRecord {
  reviewerDescriptor: string;
  voteTimeUtc: Date | null;
}

/** Business meaning of reviewer vote thresholds (Azure DevOps values mapped). */
export function mapVote(kind: ReviewerVoteNumber): VoteKind {
  const v = typeof kind === "number" ? kind : Number(kind);
  if (Number.isNaN(v)) return "none";
  if (v >= 10) return "approved";
  if (v >= 5) return "approved_suggestions"; // ApprovedWithSuggestions
  if (v <= -10) return "rejected";
  if (v < 0) return "waiting_author";
  return "none";
}

export type ReviewerVoteNumber =
  | 10
  | 5
  | 0
  | -5
  | -10
  | number;

/** True when vote satisfies “approved” for policy/metrics (`>= 5` per product spec). */
export function voteIsApproved(vote: VoteKind): boolean {
  return vote === "approved" || vote === "approved_suggestions";
}

export interface CommentThreadSummary {
  id: number;
  isResolved: boolean;
  deleted: boolean;
  /** Content hash fingerprint for unresolved comment bodies */
  lastCommentId: number;
}

export type CheckRunState =
  | "passed"
  | "failed"
  | "pending"
  | "neutral"
  | "unknown";
