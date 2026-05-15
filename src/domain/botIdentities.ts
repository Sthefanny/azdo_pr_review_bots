/**
 * Bot / tool accounts (e.g. Qodo) that should not count as human reviewers,
 * should not trigger reviewer-vote detection / leaderboard stats, and should not inflate
 * unresolved thread counts when they are the only participant in a thread.
 */
export function isQodoBotIdentity(params: {
  displayName?: string | null;
  uniqueName?: string | null;
}): boolean {
  const parts = [params.displayName, params.uniqueName]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => s.toLowerCase());
  return parts.some((s) => s.includes("qodo"));
}
