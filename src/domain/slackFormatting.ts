/** Escape Slack mrkdwn special characters in arbitrary user/ADO text. */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape and clamp PR title length for the *visible* part of `<url|label>` links (keeps each block short). */
export function truncatePrLinkLabel(title: string, maxChars = 90): string {
  const esc = escapeSlackMrkdwn(title);
  if (esc.length <= maxChars) return esc;
  return `${esc.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** Truncate mrkdwn to stay under Slack hard limits (~3000). Prefer several small sections instead of one blob. */
export function truncateForSlackSection(s: string, max = 2900): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 24)}…\n_truncated_`;
}
