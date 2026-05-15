import type { TeamConfig } from "../config/configSchema.js";
import type {
    PersonalNotificationEvent,
    PersonalNotificationEventType,
    PullRequestSnapshot,
} from "../models/domainTypes.js";
import type { NormalizedCheck } from "./checksAnalyzer.js";
import { hasNewCommentSince, hasResolvedThreadSince } from "./commentsAnalyzer.js";

function parseChecks(json: string): NormalizedCheck[] {
  try {
    return JSON.parse(json) as NormalizedCheck[];
  } catch {
    return [];
  }
}

function reviewerVotesFingerprint(snapshot: PullRequestSnapshot): string {
  return JSON.stringify(snapshot.reviewers.map((r) => [r.descriptor, r.vote]));
}

export function detectPersonalNotificationEvents(params: {
  team: TeamConfig;
  previous: PullRequestSnapshot | null;
  current: PullRequestSnapshot;
  prUrl: string;
  actorEmail?: string | null;
}): PersonalNotificationEvent[] {
  const { team, previous, current, prUrl } = params;
  const actor = params.actorEmail?.trim().toLowerCase() ?? "";

  if (!team.subscriptions.enabled) return [];
  if (current.isDraft) return [];

  const notify = team.subscriptions.notifyOn;
  const dm = team.subscriptions.dmRules;
  const events: PersonalNotificationEvent[] = [];

  const title = current.title;
  const link = `<${prUrl}|${title}>`;

  const pushEvent = (
    type: PersonalNotificationEventType,
    text: string,
    parts: Record<string, string | undefined>,
    authorOnly?: boolean,
  ): void => {
    events.push({
      type,
      prId: current.pullRequestId,
      title,
      text,
      userIds: [],
      dedupeParts: parts,
      authorOnly,
    });
  };

  if (!previous) return events;

  if (notify.newComments && hasNewCommentSince(previous.threadsJson, current.threadsJson)) {
    const text = `New comment on a PR you follow: ${title}\n${link}`;
    pushEvent("new_comment", text, { thread: current.threadSummariesHash });
  }

  if (notify.resolvedComments && hasResolvedThreadSince(previous.threadsJson, current.threadsJson)) {
    const text = `A comment thread was resolved on: ${title}\n${link}`;
    pushEvent("resolved_thread", text, { thread: current.threadSummariesHash });
  }

  const prevChecks = parseChecks(previous.checksJson);
  const currChecks = parseChecks(current.checksJson);

  const prevFailed = new Set(
    prevChecks.filter((c) => c.state === "failed").map((c) => c.name),
  );
  const currFailed = new Set(
    currChecks.filter((c) => c.state === "failed").map((c) => c.name),
  );

  if (notify.buildFailed) {
    for (const name of currFailed) {
      if (!prevFailed.has(name)) {
        const text = `Your PR build failed: ${title}\n${link}\nFailed check: ${name}`;
        pushEvent(
          "build_failed",
          text,
          { check: name },
          team.subscriptions.dmRules.buildFailedAuthorOnly,
        );
      }
    }
  }

  if (notify.buildSucceededAfterFailure) {
    for (const name of prevFailed) {
      if (!currFailed.has(name)) {
        const now = currChecks.find((c) => c.name === name);
        if (now?.state === "passed") {
          const text = `Your PR build is passing again: ${title}\n${link}\nCheck: ${name}`;
          pushEvent("build_recovered", text, { check: name }, team.subscriptions.dmRules.buildFailedAuthorOnly);
        }
      }
    }
  }

  if (notify.approvalChanged && reviewerVotesFingerprint(previous) !== reviewerVotesFingerprint(current)) {
    const text = `Approval status changed on: ${title}\n${link}`;
    pushEvent("approval_changed", text, { votes: reviewerVotesFingerprint(current) });
  }

  if (notify.mergeConflicts && !previous.mergeConflict && current.mergeConflict) {
    const text = `Your PR has merge conflicts with the target branch: ${title}\n${link}`;
    pushEvent(
      "merge_conflict",
      text,
      { conflict: String(current.mergeConflict) },
      team.subscriptions.dmRules.mergeConflictAuthorOnly,
    );
  }

  if (notify.prMerged && previous.status !== "completed" && current.status === "completed") {
    const text = `PR merged: ${title}\n${link}`;
    pushEvent("pr_merged", text, { status: current.status });
  }

  if (notify.prAbandoned && previous.status !== "abandoned" && current.status === "abandoned") {
    const text = `PR abandoned: ${title}\n${link}`;
    pushEvent("pr_abandoned", text, { status: current.status });
  }

  if (notify.newPushAfterReview) {
    const prevCommit = previous.lastSourceCommitId;
    const currCommit = current.lastSourceCommitId;
    const hadReview = previous.reviewers.some((r) => r.vote !== "none");
    if (hadReview && prevCommit && currCommit && prevCommit !== currCommit) {
      const text = `New changes were pushed to a PR you reviewed: ${title}\n${link}`;
      pushEvent("new_push_after_review", text, { commit: currCommit ?? "" });
    }
  }

  void actor;
  void dm;

  return events;
}
