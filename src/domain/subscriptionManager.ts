import type { ThreadEntity } from "../clients/azureDevOpsClient.js";
import type { TeamConfig } from "../config/configSchema.js";
import type { PullRequestSnapshot, Subscription, SubscriptionType } from "../models/domainTypes.js";
import { utcNow } from "../utils/dateTime.js";
import { extractCommentAuthors } from "./commentsAnalyzer.js";

function normalizeEmail(value?: string | null): string | null {
  if (!value) return null;
  const t = value.trim().toLowerCase();
  return t.includes("@") ? t : null;
}

export function slackUserIdForEmail(team: TeamConfig, email: string | null): string | undefined {
  const key = normalizeEmail(email);
  if (!key) return undefined;
  return team.slack.userMapping[key];
}

export function subscriptionsForSnapshot(
  team: TeamConfig,
  snap: PullRequestSnapshot,
  threads: ThreadEntity[],
): Subscription[] {
  if (!team.subscriptions.enabled) return [];

  const now = utcNow();
  const bySlack = new Map<string, Subscription>();

  const add = (email: string | null, type: SubscriptionType): void => {
    const slackId = slackUserIdForEmail(team, email);
    if (!slackId) return;
    const existing = bySlack.get(slackId);
    const precedence: Record<SubscriptionType, number> = {
      manual: 4,
      reviewer: 3,
      commenter: 2,
      author: 1,
    };
    if (!existing || precedence[type] > precedence[existing.subscriptionType]) {
      bySlack.set(slackId, {
        teamId: team.id,
        pullRequestId: snap.pullRequestId,
        slackUserId: slackId,
        azureDevOpsEmail: normalizeEmail(email),
        subscriptionType: type,
        createdAtUtc: existing?.createdAtUtc ?? now,
        updatedAtUtc: now,
        isActive: snap.status === "active",
      });
    }
  };

  if (team.subscriptions.autoSubscribeAuthors) {
    add(snap.authorEmail, "author");
  }

  if (team.subscriptions.autoSubscribeReviewers) {
    for (const reviewer of snap.reviewers) {
      const emailGuess =
        reviewer.uniqueName?.includes("@") ? reviewer.uniqueName : reviewer.displayName.includes("@")
          ? reviewer.displayName
          : null;
      add(emailGuess, "reviewer");
    }
  }

  if (team.subscriptions.autoSubscribeCommenters) {
    for (const email of extractCommentAuthors(threads)) {
      add(email, "commenter");
    }
  }

  return [...bySlack.values()];
}
