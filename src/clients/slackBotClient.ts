import { WebClient } from "@slack/web-api";

import { createLogger } from "../utils/logger.js";

const logger = createLogger("slack-bot");

export async function postSlackDm(params: {
  botToken: string;
  userId: string;
  text: string;
  dryRun: boolean;
}): Promise<void> {
  if (params.dryRun) {
    logger.info(`[dry-run] DM -> ${params.userId}: ${params.text.slice(0, 120)}`);
    return;
  }

  const client = new WebClient(params.botToken);
  const opened = await client.conversations.open({ users: params.userId });
  const channel = (opened.channel as { id?: string } | undefined)?.id;
  if (!channel) {
    throw new Error("Unable to open Slack DM channel");
  }

  await client.chat.postMessage({ channel, text: params.text, mrkdwn: true });
}
