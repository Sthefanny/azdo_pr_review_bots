import { describe, expect, it } from "vitest";

import { escapeSlackMrkdwn, truncatePrLinkLabel } from "./slackFormatting.js";

describe("escapeSlackMrkdwn", () => {
  it("escapes Slack-disruptive characters", () => {
    expect(escapeSlackMrkdwn("a < b > c & d")).toBe("a &lt; b &gt; c &amp; d");
  });
});

describe("truncatePrLinkLabel", () => {
  it("returns escaped text unchanged when short", () => {
    expect(truncatePrLinkLabel("Fix login")).toBe("Fix login");
  });

  it("escapes then truncates with ellipsis", () => {
    const long = "x".repeat(120);
    const out = truncatePrLinkLabel(long, 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(20);
  });
});
