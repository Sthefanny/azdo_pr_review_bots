import type { TeamConfig } from "../config/configSchema.js";
import type { LeaderboardMetrics, PullRequestDebtRow, ReviewDebtMetrics } from "../models/domainTypes.js";
import { formatDurationApprox } from "./businessTime.js";
import {
    escapeSlackMrkdwn,
    truncateForSlackSection,
    truncatePrLinkLabel,
} from "./slackFormatting.js";

function chunkLines(lines: string[], chunkSize: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    out.push(lines.slice(i, i + chunkSize));
  }
  return out;
}

function fmtHoursMinutes(totalMinutes: number | null): string {
  if (totalMinutes === null || !Number.isFinite(totalMinutes)) return "n/a";
  return formatDurationApprox(totalMinutes);
}

/** Outgoing webhook body built from {@link slackWebhookClient}. */
export interface SlackRichMessage {
  /** Short line for mobile / legacy (recommended under ~300 chars). */
  notificationText: string;
  /** Severity hue used in code (dry-run logs). Not sent to Slack unless you switch back to attachments. */
  attachmentColor: string;
  attachmentFallback: string;
  blocks: unknown[];
}

function trimTrailingDividers(blocks: unknown[]): void {
  while (
    blocks.length > 0 &&
    typeof blocks[blocks.length - 1] === "object" &&
    blocks[blocks.length - 1] !== null &&
    (blocks[blocks.length - 1] as { type?: string }).type === "divider"
  ) {
    blocks.pop();
  }
}

function header(title: string): unknown {
  const t = title.length > 147 ? `${title.slice(0, 144)}…` : title;
  return {
    type: "header",
    text: {
      type: "plain_text",
      text: t,
      emoji: true,
    },
  };
}

function contextElements(lines: string[]): unknown {
  return {
    type: "context",
    elements: lines.map((t) => ({
      type: "mrkdwn",
      text: t,
    })),
  };
}

function sectionMrkdwn(text: string): unknown {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncateForSlackSection(text),
    },
  };
}

function sectionFields(rows: Array<{ label: string; value: string }>): unknown[] {
  const fields: unknown[] = [];
  for (const row of rows) {
    fields.push({
      type: "mrkdwn",
      text: `*${row.label}*\n${row.value}`,
    });
  }
  return [{ type: "section", fields }];
}

function divider(): unknown {
  return { type: "divider" };
}

/** Daily debt — Block Kit sections posted as top-level webhook `blocks` (avoids attachment collapse). */
export function buildDailyReviewDebtRichMessage(
  team: TeamConfig,
  metrics: ReviewDebtMetrics,
  urlResolver: (prId: number) => string,
): SlackRichMessage {
  const blocks: unknown[] = [];

  blocks.push(header(`:bar_chart: PR review · ${team.displayName}`));

  blocks.push(
    contextElements([
      ":spiral_calendar_pad: Scheduled summary — Azure DevOps / Slack",
      team.reviewDebt.includeNeedsAttention
        ? `:pushpin: Up to ${team.reviewDebt.maxNeedsAttentionItems} “needs attention” items`
        : ":information_source: Needs-attention section disabled",
    ]),
  );

  blocks.push(divider());

  blocks.push(...sectionFields([
    {
      label: ":eyes: Open / awaiting review",
      value: `*${metrics.openWaitingReview}*`,
    },
    {
      label: ":construction: Blocked · checks",
      value: String(metrics.blockedChecks.length),
    },
    {
      label: ":speech_balloon: Blocked · threads",
      value: String(metrics.blockedUnresolved.length),
    },
    {
      label: ":hourglass_flowing_sand: Oldest wait",
      value: fmtHoursMinutes(metrics.oldestWaitingMinutes),
    },
  ]));

  const slaKeys = [...metrics.waitingFirstGtSla.keys()].sort((a, b) => a - b);
  const slaBodyLines = slaKeys.map(
    (k) =>
      `• Past *${k}* business day(s) waiting for reviewer vote: *${metrics.waitingFirstGtSla.get(k) ?? 0}* PRs`,
  );
  const slaTitle = ":dart: *SLA snapshots*";
  if (slaBodyLines.length === 0) {
    blocks.push(sectionMrkdwn(`${slaTitle}\n_No SLA buckets this run._`));
  } else {
    for (const [idx, lines] of chunkLines(slaBodyLines, 8).entries()) {
      const prefix = idx === 0 ? `${slaTitle}\n` : "";
      blocks.push(sectionMrkdwn(`${prefix}${lines.join("\n")}`));
    }
  }

  const paceLines = [
    `Avg first review · last week: *${fmtHoursMinutes(metrics.avgTimeToFirstReviewMinutesWeek)}*`,
    `Avg ready → approval · last week: *${fmtHoursMinutes(metrics.avgReadyToApprovalMinutesWeek)}*`,
  ];

  blocks.push(sectionMrkdwn(`:gear: *Flow & pace*\n${paceLines.join("\n")}`));

  blocks.push(divider());

  if (team.reviewDebt.includeNeedsAttention) {
    blocks.push(sectionMrkdwn(":warning: *Needs attention*"));

    const items = metrics.slaNeedsAttention.slice(0, team.reviewDebt.maxNeedsAttentionItems);

    if (items.length === 0) {
      blocks.push(sectionMrkdwn(":white_check_mark: _Nothing crossed the thresholds — nice._"));
    } else {
      items.forEach((row: PullRequestDebtRow, idx: number) => {
        const pr = row.pr;
        const link = `<${urlResolver(pr.pullRequestId)}|${truncatePrLinkLabel(pr.title)}>`;
        const wait = fmtHoursMinutes(Math.round((Date.now() - pr.createdAtUtc.getTime()) / 60_000));
        const missing: string[] = [];
        if (row.missingFirstReview) missing.push("reviewer vote");
        if (row.waitingForLeadApproval) missing.push("lead approval");
        const badge =
          idx === 0 ? ":large_orange_circle:" : idx === 1 ? ":large_yellow_circle:" : ":small_blue_diamond:";

        const lines = [
          `${badge} *${idx + 1}.* ${link}`,
          `   _Author:_ ${escapeSlackMrkdwn(pr.authorName)} · _Waiting:_ ${wait} · _Missing:_ ${missing.join(", ") || "follow-up"}`,
        ];
        if (pr.unresolvedCommentThreads > 0) {
          const n = pr.unresolvedCommentThreads;
          lines.push(`   :left_speech_bubble: ${n} unresolved thread${n === 1 ? "" : "s"}`);
        }

        blocks.push(sectionMrkdwn(lines.join("\n")));
      });

      if (metrics.slaNeedsAttention.length > items.length) {
        blocks.push(
          contextElements([
            `_Showing ${items.length} of ${metrics.slaNeedsAttention.length} — raise \`maxNeedsAttentionItems\` to see more._`,
          ]),
        );
      }
    }
  }

  const attentionLoad = metrics.slaNeedsAttention.length + metrics.blockedChecks.length;
  const color =
    attentionLoad > 8 || metrics.openWaitingReview > 15
      ? "#E8912E"
      : attentionLoad > 0
        ? "#2D8CFF"
        : "#2EB67D";

  const notificationText = `PR review · ${team.displayName} — ${metrics.openWaitingReview} open, ${metrics.blockedChecks.length} blocked by checks`;

  trimTrailingDividers(blocks);
  if (blocks.length > 50) {
    blocks.splice(49);
    blocks.push(sectionMrkdwn("_Truncated — too many sections for one Slack message._"));
  }

  return {
    notificationText,
    attachmentColor: color,
    attachmentFallback: notificationText,
    blocks,
  };
}

export interface WeeklyLeaderboardExtras {
  /** Random celebration GIF URL from Giphy for the #1 reviewer (Slack `image` block). */
  winnerGif?: { imageUrl: string; altText: string } | undefined;
}

/** Weekly leaderboard — celebratory layout. */
export function buildWeeklyLeaderboardRichMessage(
  team: TeamConfig,
  metrics: LeaderboardMetrics,
  extras?: WeeklyLeaderboardExtras,
): SlackRichMessage {
  const blocks: unknown[] = [];

  blocks.push(header(`:trophy: Weekly PR highlights · ${team.displayName}`));

  const lookback = team.leaderboard.lookbackDays;
  /** `context` = small meta text like before; `section` would use normal body size. */
  blocks.push(
    contextElements([
      `:spiral_calendar_pad: Last *${lookback}* days — *${metrics.prsMergedTotal}* PRs merged · *${metrics.prsReviewedTotal}* with review activity`,
    ]),
  );
  blocks.push(contextElements([":heart: Thanks for keeping reviews kind and fast"]));
  blocks.push(divider());

  if (team.leaderboard.showTopReviewers && metrics.topReviewers.length > 0) {
    const medals = [":first_place_medal:", ":second_place_medal:", ":third_place_medal:"];
    blocks.push(sectionMrkdwn(":people_holding_hands: *Top reviewers*"));
    metrics.topReviewers.forEach((row, idx) => {
      const medal = medals[idx] ?? ":star:";
      blocks.push(
        sectionMrkdwn(
          `${medal} *${escapeSlackMrkdwn(row.displayName)}* — *${row.reviewedPullRequestCount}* PRs reviewed`,
        ),
      );
    });

    const winner = metrics.topReviewers[0];
    const gif = extras?.winnerGif;
    if (winner && gif) {
      blocks.push(
        sectionMrkdwn(
          `:tada: *Winner treat* for *${escapeSlackMrkdwn(winner.displayName)}* — _a random celebration for carrying reviews this week_`,
        ),
      );
      blocks.push({
        type: "image",
        image_url: gif.imageUrl,
        alt_text: gif.altText,
      });
    }

    blocks.push(divider());
  }

  if (team.leaderboard.showTeamStats) {
    blocks.push(
      ...sectionFields([
        {
          label: ":handshake: PRs with review activity",
          value: String(metrics.prsReviewedTotal),
        },
        {
          label: ":white_check_mark: PRs merged",
          value: String(metrics.prsMergedTotal),
        },
        {
          label: ":stopwatch: Avg · first review",
          value: fmtHoursMinutes(metrics.avgFirstReviewMinutes),
        },
        {
          label: ":rocket: Avg · ready → merge",
          value: fmtHoursMinutes(metrics.avgReadyToMergeMinutes),
        },
      ]),
    );
    blocks.push(divider());
  }

  if (team.leaderboard.showSpecialThanks) {
    const bullets: string[] = [];
    const s = metrics.specials;
    if (s.fastestFirstReviewReviewer) {
      bullets.push(
        `:zap: *Fast first review:* ${escapeSlackMrkdwn(s.fastestFirstReviewReviewer.name)} — ${fmtHoursMinutes(s.fastestFirstReviewReviewer.minutes)}`,
      );
    }
    if (s.mostCommentsReviewer) {
      bullets.push(
        `:speech_balloon: *Most helpful comments:* ${escapeSlackMrkdwn(s.mostCommentsReviewer.name)} — ${s.mostCommentsReviewer.count}`,
      );
    }
    if (s.mostApprovalsReviewer) {
      bullets.push(
        `:heavy_check_mark: *Most approvals:* ${escapeSlackMrkdwn(s.mostApprovalsReviewer.name)} — ${s.mostApprovalsReviewer.count}`,
      );
    }
    if (bullets.length > 0) {
      blocks.push(sectionMrkdwn(":sparkles: *Shout-outs*"));
      for (const line of bullets) {
        blocks.push(sectionMrkdwn(line));
      }
    }
  }

  const topN = metrics.topReviewers.length;
  const lead =
    topN > 0
      ? `${escapeSlackMrkdwn(metrics.topReviewers[0]!.displayName)} (${metrics.topReviewers[0]!.reviewedPullRequestCount} PRs)`
      : "none in the ranked list";
  const notificationText = `Weekly PR highlights · ${team.displayName} — last ${lookback}d: ${metrics.prsMergedTotal} merged, ${metrics.prsReviewedTotal} with review activity; ${topN} top reviewer${topN === 1 ? "" : "s"} — ${lead}`;

  trimTrailingDividers(blocks);

  return {
    notificationText,
    attachmentColor: "#B35900",
    attachmentFallback: notificationText,
    blocks,
  };
}
