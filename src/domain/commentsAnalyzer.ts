import type { IdentityRef, ThreadEntity } from "../clients/azureDevOpsClient.js";
import type { CommentThreadSummary } from "../models/snapshotTypes.js";
import { fnv1aHex } from "../utils/hash.js";
import { isQodoBotIdentity } from "./botIdentities.js";

type ThreadStatus = "active" | "fixed" | "pending" | "unknown";

function mapThreadStatus(status: ThreadEntity["status"]): ThreadStatus {
  const raw = String(status ?? "").toLowerCase();
  if (raw.includes("active")) return "active";
  if (raw.includes("fixed") || raw.includes("closed") || raw.includes("resolved")) return "fixed";
  if (raw.includes("pending")) return "pending";
  return "unknown";
}

function isLiveNonSystemComment(c: {
  commentType?: string;
  deletedDate?: string;
}): boolean {
  if (String(c.commentType ?? "").toLowerCase() === "system") return false;
  if (typeof c.deletedDate === "string" && c.deletedDate.length > 0) return false;
  return true;
}

/** Thread counts as “unresolved for humans” only if a non-system live comment exists from a non-bot identity. */
function threadHasUnresolvedHumanDiscussion(thread: ThreadEntity): boolean {
  for (const c of thread.comments ?? []) {
    if (!isLiveNonSystemComment(c)) continue;
    const author = (c as { author?: IdentityRef }).author;
    if (
      isQodoBotIdentity({
        displayName: author?.displayName,
        uniqueName: author?.uniqueName,
      })
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function isResolved(status: ThreadStatus): boolean {
  return status === "fixed";
}

export function summarizeThreads(threads: ThreadEntity[]): {
  summaries: CommentThreadSummary[];
  unresolvedCount: number;
  hash: string;
  threadsJson: string;
} {
  const summaries: CommentThreadSummary[] = [];
  let unresolvedCount = 0;

  let threadId = 0;
  for (const thread of threads) {
    const id = typeof thread.id === "number" ? thread.id : threadId++;
    const status = mapThreadStatus(thread.status);
    const resolved = isResolved(status);
    const comments = thread.comments ?? [];
    let lastCommentId = 0;
    let deleted = Boolean(thread.isDeleted);

    for (const c of comments) {
      if (typeof c.id === "number") lastCommentId = c.id;
      if (typeof c.deletedDate === "string" && c.deletedDate.length) deleted = true;
    }

    summaries.push({
      id,
      isResolved: resolved,
      deleted,
      lastCommentId,
    });

    if (!deleted && !resolved && threadHasUnresolvedHumanDiscussion(thread)) unresolvedCount += 1;
  }

  const threadsJson = JSON.stringify({ summaries });
  const hash = fnv1aHex(threadsJson);

  return { summaries, unresolvedCount, hash, threadsJson };
}

export function extractCommentAuthors(threads: ThreadEntity[]): Set<string> {
  const emails = new Set<string>();
  for (const thread of threads) {
    for (const comment of thread.comments ?? []) {
      if (!isLiveNonSystemComment(comment)) continue;
      const author = (comment as { author?: IdentityRef }).author;
      if (
        isQodoBotIdentity({
          displayName: author?.displayName,
          uniqueName: author?.uniqueName,
        })
      ) {
        continue;
      }
      const email = author?.uniqueName?.toLowerCase() ?? "";
      if (email.includes("@")) emails.add(email);
    }
  }
  return emails;
}

export function hasNewCommentSince(previousJson: string | undefined, currentJson: string): boolean {
  if (!previousJson || previousJson.length === 0) return true;
  if (previousJson === currentJson) return false;
  try {
    const prev = JSON.parse(previousJson) as { summaries?: CommentThreadSummary[] };
    const curr = JSON.parse(currentJson) as { summaries?: CommentThreadSummary[] };
    const prevMap = new Map<number, number>();
    for (const s of prev.summaries ?? []) prevMap.set(s.id, s.lastCommentId);
    for (const s of curr.summaries ?? []) {
      const old = prevMap.get(s.id);
      if (old === undefined && !s.deleted) return true;
      if (old !== undefined && s.lastCommentId > old) return true;
    }
    if ((curr.summaries ?? []).length !== (prev.summaries ?? []).length) return true;
  } catch {
    return true;
  }
  return false;
}

export function hasResolvedThreadSince(previousJson: string | undefined, currentJson: string): boolean {
  if (!previousJson) return false;
  try {
    const prev = JSON.parse(previousJson) as { summaries?: CommentThreadSummary[] };
    const curr = JSON.parse(currentJson) as { summaries?: CommentThreadSummary[] };
    const prevMap = new Map<number, boolean>();
    for (const s of prev.summaries ?? []) {
      prevMap.set(s.id, s.isResolved);
    }
    for (const s of curr.summaries ?? []) {
      const wasResolved = prevMap.get(s.id);
      if (wasResolved === false && s.isResolved) return true;
    }
  } catch {
    return false;
  }
  return false;
}
