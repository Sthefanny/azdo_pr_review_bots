import { describe, expect, it } from "vitest";

import { normalizeChecks } from "./checksAnalyzer.js";
import type { TeamConfig } from "../config/configSchema.js";
import type { StatusEntity } from "../clients/azureDevOpsClient.js";

const checksCfg: TeamConfig["checks"] = {
  enabled: true,
  ignoredChecks: ["PR Title Check"],
  relevantChecks: ["Good Build"],
};

describe("checksAnalyzer", () => {
  it("filters ignored and tracks failures", () => {
    const statuses: StatusEntity[] = [
      { state: "failed", context: { name: "Good Build" } },
      { state: "succeeded", context: { name: "PR Title Check" } },
    ];
    const out = normalizeChecks(statuses, checksCfg);
    expect(out.failedRelevantNames).toEqual(["Good Build"]);
  });
});
