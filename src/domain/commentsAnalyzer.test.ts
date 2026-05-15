import { describe, expect, it } from "vitest";

import type { ThreadEntity } from "../clients/azureDevOpsClient.js";
import { summarizeThreads } from "./commentsAnalyzer.js";

describe("summarizeThreads", () => {
  it("does not count threads that only have system comments", () => {
    const threads: ThreadEntity[] = [
      {
        id: 1,
        status: "active",
        comments: [{ id: 1, commentType: "system", content: "x" }],
      },
      {
        id: 2,
        status: "active",
        comments: [{ id: 2, commentType: "system", content: "y" }],
      },
    ];
    const { unresolvedCount } = summarizeThreads(threads);
    expect(unresolvedCount).toBe(0);
  });

  it("does not count unresolved threads where the only live comments are from Qodo", () => {
    const threads: ThreadEntity[] = [
      {
        id: 1,
        status: "active",
        comments: [
          {
            id: 1,
            commentType: "text",
            author: { displayName: "Qodo Merge", uniqueName: "qodo@example.com" },
          },
        ],
      },
    ];
    expect(summarizeThreads(threads).unresolvedCount).toBe(0);
  });

  it("counts one unresolved thread when a human left a live comment", () => {
    const threads: ThreadEntity[] = [
      {
        id: 1,
        status: "active",
        comments: [
          {
            id: 1,
            commentType: "text",
            author: { displayName: "Pat", uniqueName: "pat@contoso.com" },
          },
        ],
      },
    ];
    expect(summarizeThreads(threads).unresolvedCount).toBe(1);
  });
});
