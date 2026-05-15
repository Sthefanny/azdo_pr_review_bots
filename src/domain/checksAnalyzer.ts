import type { StatusEntity } from "../clients/azureDevOpsClient.js";
import type { TeamConfig } from "../config/configSchema.js";
import type { CheckRunState } from "../models/snapshotTypes.js";

export interface NormalizedCheck {
  name: string;
  state: CheckRunState;
}

function mapStatusState(raw: unknown): CheckRunState {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("fail") || s.includes("error")) return "failed";
  if (s.includes("success") || s.includes("succeed") || s === "completed") return "passed";
  if (s.includes("pending") || s.includes("inprogress") || s.includes("running") || s === "queued") {
    return "pending";
  }
  if (s.includes("notapplicable") || s.includes("no-op") || s === "neutral") return "neutral";
  return "unknown";
}

function resolveName(status: StatusEntity): string {
  const ctxName = status.context?.name;
  if (typeof ctxName === "string" && ctxName.length) return ctxName;
  if (typeof status.name === "string" && status.name.length) return status.name;
  return "unnamed";
}

/** Normalize PR statuses, honoring ignore/relevant filters. */
export function normalizeChecks(
  statuses: StatusEntity[],
  checksCfg: TeamConfig["checks"],
): {
  all: NormalizedCheck[];
  relevant: NormalizedCheck[];
  failedRelevantNames: string[];
} {
  const all: NormalizedCheck[] = statuses.map((s) => ({
    name: resolveName(s),
    state: mapStatusState(s.state),
  }));

  const ignored = new Set(checksCfg.ignoredChecks.map((s) => s.toLowerCase()));

  const relevantList = checksCfg.relevantChecks.length
    ? checksCfg.relevantChecks
    : [...new Set(all.map((c) => c.name))];

  const relevantAllow = new Set(relevantList.map((s) => s.toLowerCase()));

  const relevant = all.filter(
    (c) =>
      !ignored.has(c.name.toLowerCase()) && relevantAllow.has(c.name.toLowerCase()),
  );

  const failedRelevantNames = [
    ...new Set(
      relevant.filter((c) => c.state === "failed").map((c) => c.name),
    ),
  ];

  return { all, relevant, failedRelevantNames };
}
