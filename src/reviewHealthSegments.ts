import { timerLeaseRowKey } from "./clients/tableStorageClient.js";

export type ReviewHealthSegment = "review-debt" | "leaderboard" | "subscriptions";

export function leaseKeyForSegment(segment: ReviewHealthSegment): string {
  return timerLeaseRowKey(segment);
}
