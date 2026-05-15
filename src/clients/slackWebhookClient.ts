import type { SlackRichMessage } from "../domain/messageBuilder.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("slack-webhook");

export async function postSlackWebhook(params: {
  dryRun: boolean;
  message: SlackRichMessage;
  webhookUrl: string;
}): Promise<void> {
  if (params.dryRun) {
    logger.info(
      `[dry-run] Would post Slack webhook: ${params.message.notificationText.slice(0, 120)} blocks=${params.message.blocks.length} (severity hue ${params.message.attachmentColor} — not shown without attachments)`,
    );
    return;
  }

  /** Top-level `blocks` avoid attachment collapse (“Show more”). Incoming webhooks cannot show the
   * colored sidebar without `attachments`; `attachmentColor` is kept for logs / future use. */
  const body: Record<string, unknown> = {
    text: params.message.notificationText,
    blocks: params.message.blocks,
  };

  const res = await fetch(params.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Slack webhook POST failed ${res.status}: ${txt}`);
  }

  logger.info("Slack webhook accepted (HTTP 2xx)");
}
