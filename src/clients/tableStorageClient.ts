import { TableClient } from "@azure/data-tables";

import type {
    NotificationState,
    PullRequestSnapshot,
    ScheduleName,
    ScheduleState,
    Subscription,
} from "../models/domainTypes.js";

const LEASE_PARTITION = "__singleton";

/** Default lease row key when callers omit `leaseRowKey` (explicit keys preferred). */
export const DEFAULT_TIMER_LEASE_ROW_KEY = "timer-lock";

export function timerLeaseRowKey(segment: string): string {
  const s = segment.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return `timer-lock-${s || "unknown"}`;
}

export interface TableClientsBundle {
  snapshots: TableClient;
  subscriptions: TableClient;
  schedule: TableClient;
  notifications: TableClient;
  leaseClient: TableClient;
}

export async function createTableClients(
  connectionString: string,
  names: {
    snapshots: string;
    subscriptions: string;
    schedule: string;
    notifications: string;
  },
): Promise<TableClientsBundle> {
  const snapshots = TableClient.fromConnectionString(connectionString, names.snapshots);
  const subscriptions = TableClient.fromConnectionString(connectionString, names.subscriptions);
  const schedule = TableClient.fromConnectionString(connectionString, names.schedule);
  const notifications = TableClient.fromConnectionString(connectionString, names.notifications);
  await Promise.all([
    snapshots.createTable(),
    subscriptions.createTable(),
    schedule.createTable(),
    notifications.createTable(),
  ]);
  return { snapshots, subscriptions, schedule, notifications, leaseClient: schedule };
}

async function leaseAcquire(
  scheduleTable: TableClient,
  ttlMs: number,
  ownerId: string,
  rowKey: string,
): Promise<boolean> {
  const nowMs = Date.now();
  try {
    const existing = await scheduleTable
      .getEntity<{ leaseExpires?: string }>(LEASE_PARTITION, rowKey)
      .catch(() => null);

    const until = parseIsoMs(existing?.leaseExpires);
    if (until !== null && until > nowMs + 250) return false;

    await scheduleTable.upsertEntity(
      {
        partitionKey: LEASE_PARTITION,
        rowKey,
        leaseOwner: ownerId,
        leaseExpires: new Date(nowMs + ttlMs).toISOString(),
      },
      "Replace",
    );
    return true;
  } catch {
    return false;
  }
}

export async function tryAcquireTimerLease(
  scheduleTable: TableClient,
  ttlMs: number,
  ownerId: string,
  /** Defaults to {@link DEFAULT_TIMER_LEASE_ROW_KEY} when omitted (prefer an explicit segment key). */
  leaseRowKey: string = DEFAULT_TIMER_LEASE_ROW_KEY,
): Promise<boolean> {
  return leaseAcquire(scheduleTable, ttlMs, ownerId, leaseRowKey);
}

export async function releaseTimerLease(
  scheduleTable: TableClient,
  leaseRowKey: string = DEFAULT_TIMER_LEASE_ROW_KEY,
): Promise<void> {
  await scheduleTable
    .deleteEntity(LEASE_PARTITION, leaseRowKey)
    .catch(() =>
      scheduleTable
        .upsertEntity(
          {
            partitionKey: LEASE_PARTITION,
            rowKey: leaseRowKey,
            leaseExpires: new Date(0).toISOString(),
            leaseOwner: "released",
          },
          "Replace",
        )
        .catch(() => undefined),
    );
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export function snapshotRowFromModel(snapshot: PullRequestSnapshot): Record<string, unknown> {
  return {
    partitionKey: snapshot.teamId,
    rowKey: String(snapshot.pullRequestId),

    pullRequestId: snapshot.pullRequestId,
    title: snapshot.title,
    authorName: snapshot.authorName,
    authorEmail: snapshot.authorEmail ?? "",
    authorDescriptor: snapshot.authorDescriptor ?? "",
    sourceBranch: snapshot.sourceBranch,
    targetBranch: snapshot.targetBranch,
    targetRefName: snapshot.targetRefName ?? "",
    status: snapshot.status,
    isDraft: snapshot.isDraft,
    labelsJson: stringifyJson(snapshot.labels),
    createdAt: snapshot.createdAtUtc.toISOString(),
    closedAt: snapshot.closedAtUtc ? snapshot.closedAtUtc.toISOString() : "",
    reviewersJson: stringifyJson(snapshot.reviewers),
    approvalsJson: stringifyJson(snapshot.approvalsByDescriptor),
    unresolvedCommentThreads: snapshot.unresolvedCommentThreads,
    threadSummariesHash: snapshot.threadSummariesHash,
    threadsJson: snapshot.threadsJson,
    checksEnabled: snapshot.checksEnabled,
    checksJson: snapshot.checksJson,
    failedChecksJson: stringifyJson(snapshot.failedRelevantChecks),
    mergeConflict: snapshot.mergeConflict,
    lastSourceCommitId: snapshot.lastSourceCommitId ?? "",
    lastIterationId: snapshot.lastKnownIterationId ?? 0,
    lastReviewCommitId: snapshot.lastReviewCommitId ?? "",
    requiredApprovalsJson: snapshot.requiredApprovalsJson,
    missingApprovalsJson: snapshot.missingRequiredApprovalsJson,
    lastSeenAt: snapshot.lastSeenAtUtc.toISOString(),
    lastUpdatedAt: snapshot.lastUpdatedAtUtc.toISOString(),
    snapshotHash: snapshot.snapshotHash,
    firstReviewAt: snapshot.firstReviewAtUtc?.toISOString() ?? "",
    firstApprovalAt: snapshot.firstApprovalAtUtc?.toISOString() ?? "",
  };
}

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function snapshotEntityToModel(teamId: string, row: Record<string, unknown>): PullRequestSnapshot {
  const reviewersJson = typeof row.reviewersJson === "string" ? row.reviewersJson : "[]";
  const approvalsJson = typeof row.approvalsJson === "string" ? row.approvalsJson : "[]";
  const labelsJson = typeof row.labelsJson === "string" ? row.labelsJson : "[]";
  const failedChecksJson =
    typeof row.failedChecksJson === "string" ? row.failedChecksJson : "[]";
  const lastIteration = Number(row.lastIterationId ?? 0);

  return {
    teamId,
    pullRequestId: Number(row.pullRequestId),
    title: String(row.title ?? ""),
    authorName: String(row.authorName ?? ""),
    authorEmail: typeof row.authorEmail === "string" && row.authorEmail.length ? row.authorEmail : null,
    authorDescriptor:
      typeof row.authorDescriptor === "string" && row.authorDescriptor.length
        ? row.authorDescriptor
        : null,
    sourceBranch: String(row.sourceBranch ?? ""),
    targetBranch: String(row.targetBranch ?? ""),
    targetRefName:
      typeof row.targetRefName === "string" && row.targetRefName.length ? row.targetRefName : "",
    status: row.status === "completed" || row.status === "abandoned" || row.status === "active"
      ? (row.status as PullRequestSnapshot["status"])
      : "active",
    isDraft: Boolean(row.isDraft),
    labels: safeParse(labelsJson, [] as string[]),
    createdAtUtc: new Date(typeof row.createdAt === "string" ? row.createdAt : 0),
    closedAtUtc: typeof row.closedAt === "string" && row.closedAt.length ? new Date(row.closedAt) : null,
    reviewers: safeParse(reviewersJson, [] as PullRequestSnapshot["reviewers"]),
    approvalsByDescriptor: safeParse(approvalsJson, [] as PullRequestSnapshot["approvalsByDescriptor"]),
    unresolvedCommentThreads: Number(row.unresolvedCommentThreads ?? 0),
    threadSummariesHash: String(row.threadSummariesHash ?? ""),
    threadsJson: String(row.threadsJson ?? "{}"),
    checksEnabled: Boolean(row.checksEnabled),
    checksSummary: undefined,
    checksJson: typeof row.checksJson === "string" ? row.checksJson : "{}",
    failedRelevantChecks: safeParse(failedChecksJson, [] as string[]),
    mergeConflict: Boolean(row.mergeConflict),
    lastSourceCommitId:
      typeof row.lastSourceCommitId === "string" && row.lastSourceCommitId.length
        ? row.lastSourceCommitId
        : null,
    lastKnownIterationId:
      Number.isFinite(lastIteration) && lastIteration > 0 ? lastIteration : null,
    lastReviewCommitId:
      typeof row.lastReviewCommitId === "string" && row.lastReviewCommitId.length
        ? row.lastReviewCommitId
        : null,
    requiredApprovalsJson: String(row.requiredApprovalsJson ?? "{}"),
    missingRequiredApprovalsJson: String(row.missingApprovalsJson ?? "{}"),
    lastSeenAtUtc: new Date(typeof row.lastSeenAt === "string" ? row.lastSeenAt : Date.now()),
    lastUpdatedAtUtc: new Date(
      typeof row.lastUpdatedAt === "string" ? row.lastUpdatedAt : new Date().toISOString(),
    ),
    snapshotHash: String(row.snapshotHash ?? ""),
    firstReviewAtUtc:
      typeof row.firstReviewAt === "string" && row.firstReviewAt.length
        ? new Date(row.firstReviewAt)
        : null,
    firstApprovalAtUtc:
      typeof row.firstApprovalAt === "string" && row.firstApprovalAt.length
        ? new Date(row.firstApprovalAt)
        : null,
  };
}

export function subscriptionRow(sub: Subscription): Record<string, unknown> {
  return {
    partitionKey: sub.teamId,
    rowKey: `${sub.pullRequestId}::${sub.slackUserId}`,
    pullRequestId: sub.pullRequestId,
    slackUserId: sub.slackUserId,
    adoEmail: sub.azureDevOpsEmail ?? "",
    subscriptionType: sub.subscriptionType,
    createdAt: sub.createdAtUtc.toISOString(),
    updatedAt: sub.updatedAtUtc.toISOString(),
    active: sub.isActive,
  };
}

export function entityToSubscription(
  entity: Record<string, unknown>,
  fallbackTeam: string | undefined,
): Subscription {
  const teamId =
    typeof entity.partitionKey === "string"
      ? entity.partitionKey
      : (fallbackTeam ?? "unknown-team");

  const rowKey = typeof entity.rowKey === "string" ? entity.rowKey : "";
  let pullRequestId = Number(entity.pullRequestId ?? NaN);
  let slackFromRow = "";

  const parts = rowKey.split("::", 3);
  if (parts.length >= 2) {
    pullRequestId = Number(parts[0]);
    slackFromRow = parts.slice(1).join("::");
  }

  if (!Number.isFinite(pullRequestId)) {
    pullRequestId = Number(entity.pullRequestId ?? 0);
  }

  const createdAtRaw =
    typeof entity.createdAt === "string" ? entity.createdAt : new Date().toISOString();
  const updatedAtRaw =
    typeof entity.updatedAt === "string" ? entity.updatedAt : createdAtRaw;

  let subscriptionType: Subscription["subscriptionType"] = "author";
  const st = typeof entity.subscriptionType === "string" ? entity.subscriptionType : "";
  if (st === "manual" || st === "reviewer" || st === "commenter" || st === "author") {
    subscriptionType = st;
  }

  return {
    teamId,
    pullRequestId,
    slackUserId:
      typeof entity.slackUserId === "string" && entity.slackUserId.length
        ? entity.slackUserId
        : slackFromRow,
    azureDevOpsEmail:
      typeof entity.adoEmail === "string" && entity.adoEmail.length ? entity.adoEmail : null,
    subscriptionType,
    createdAtUtc: new Date(createdAtRaw),
    updatedAtUtc: new Date(updatedAtRaw),
    isActive: typeof entity.active === "boolean" ? entity.active : String(entity.active) !== "false",
  };
}

export function scheduleRow(state: ScheduleState): Record<string, unknown> {
  return {
    partitionKey: state.teamId,
    rowKey: state.scheduleName,
    lastPostedAt: state.lastPostedAtUtc?.toISOString() ?? "",
    lastRunAt: state.lastRunAtUtc?.toISOString() ?? "",
  };
}

export function scheduleEntityToModel(
  teamId: string,
  scheduleName: ScheduleName,
  entity: Record<string, unknown>,
): ScheduleState {
  return {
    teamId,
    scheduleName,
    lastPostedAtUtc:
      typeof entity.lastPostedAt === "string" && entity.lastPostedAt.length
        ? new Date(entity.lastPostedAt)
        : null,
    lastRunAtUtc:
      typeof entity.lastRunAt === "string" && entity.lastRunAt.length
        ? new Date(entity.lastRunAt)
        : null,
  };
}

export function notificationRow(notification: NotificationState): Record<string, unknown> {
  return {
    partitionKey: `${notification.teamId}::${notification.pullRequestId}`,
    rowKey: `${notification.eventType}::${notification.slackUserId}`,
    teamId: notification.teamId,
    pullRequestId: notification.pullRequestId,
    slackUserId: notification.slackUserId,
    eventType: notification.eventType,
    lastEventHash: notification.lastEventHash,
    lastNotifiedAt: notification.lastNotifiedAtUtc.toISOString(),
  };
}

export function notificationEntityToModel(entity: Record<string, unknown>): NotificationState | null {
  const pk = typeof entity.partitionKey === "string" ? entity.partitionKey : "";
  let teamIdMaybe = "";
  let pullRequestRaw = "";
  if (pk.includes("::")) {
    const parts = pk.split("::", 2);
    teamIdMaybe = parts[0] ?? "";
    pullRequestRaw = parts[1] ?? "";
  } else if (typeof entity.teamId === "string") {
    teamIdMaybe = entity.teamId;
  }

  const rk = typeof entity.rowKey === "string" ? entity.rowKey : "";
  let eventTypeParsed = rk.split("::", 2)[0] ?? String(entity.eventType ?? "");
  if (!eventTypeParsed) eventTypeParsed = String(entity.eventType ?? "");

  const slackUserId =
    typeof entity.slackUserId === "string" && entity.slackUserId.length
      ? entity.slackUserId
      : rk.split("::", 2)[1] ?? "";

  const pullRequestId = Number(entity.pullRequestId ?? pullRequestRaw ?? 0);

  const teamId =
    typeof entity.teamId === "string" && entity.teamId.length
      ? entity.teamId
      : (typeof teamIdMaybe === "string" ? teamIdMaybe : String(teamIdMaybe));

  const allowedEvents = [
    "new_comment",
    "resolved_thread",
    "build_failed",
    "build_recovered",
    "approval_changed",
    "merge_conflict",
    "pr_merged",
    "pr_abandoned",
    "new_push_after_review",
  ] as const;

  if (!teamId) return null;
  if (!(allowedEvents as readonly string[]).includes(eventTypeParsed)) return null;

  return {
    teamId,
    pullRequestId,
    slackUserId,
    eventType: eventTypeParsed as NotificationState["eventType"],
    lastEventHash: String(entity.lastEventHash ?? ""),
    lastNotifiedAtUtc: new Date(
      typeof entity.lastNotifiedAt === "string"
        ? entity.lastNotifiedAt
        : new Date().toISOString(),
    ),
  };
}

export async function listSnapshots(teamId: string, client: TableClient): Promise<PullRequestSnapshot[]> {
  const snaps: PullRequestSnapshot[] = [];
  const pager = client.listEntities<Record<string, unknown>>({
    queryOptions: { filter: `PartitionKey eq '${teamId}'` },
  });

  for await (const entity of pager) {
    snaps.push(snapshotEntityToModel(teamId, { ...entity }));
  }

  return snaps;
}

export async function upsertSnapshot(client: TableClient, snapshot: PullRequestSnapshot): Promise<void> {
  await client.upsertEntity(snapshotRowFromModel(snapshot) as never, "Replace");
}

export async function pruneMissingSnapshots(
  client: TableClient,
  teamId: string,
  keep: Set<number>,
): Promise<void> {
  const snaps = await listSnapshots(teamId, client);
  await Promise.all(
    snaps.map((snap) =>
      keep.has(snap.pullRequestId)
        ? Promise.resolve()
        : client.deleteEntity(teamId, String(snap.pullRequestId)).catch(() => undefined),
    ),
  );
}

export async function listSubscriptions(teamId: string, client: TableClient): Promise<Subscription[]> {
  const rows: Subscription[] = [];
  const pager = client.listEntities<Record<string, unknown>>({
    queryOptions: { filter: `PartitionKey eq '${teamId}'` },
  });

  for await (const entity of pager) rows.push(entityToSubscription({ ...entity }, teamId));
  return rows;
}

export async function upsertSubscription(client: TableClient, sub: Subscription): Promise<void> {
  await client.upsertEntity(subscriptionRow(sub) as never, "Replace");
}

export async function getScheduleState(client: TableClient, teamId: string, name: ScheduleName): Promise<ScheduleState | null> {
  try {
    const entity = await client.getEntity<Record<string, unknown>>(teamId, name);
    return scheduleEntityToModel(teamId, name, { ...entity });
  } catch {
    return null;
  }
}

export async function saveScheduleState(client: TableClient, state: ScheduleState): Promise<void> {
  await client.upsertEntity(scheduleRow(state) as never, "Merge");
}

export async function upsertNotificationState(client: TableClient, state: NotificationState): Promise<void> {
  await client.upsertEntity(notificationRow(state) as never, "Merge");
}

export async function loadNotificationStates(
  client: TableClient,
  teamId: string,
  pullRequestId: number,
): Promise<NotificationState[]> {
  const key = `${teamId}::${pullRequestId}`;
  const pager = client.listEntities<Record<string, unknown>>({
    queryOptions: { filter: `PartitionKey eq '${key}'` },
  });

  const states: NotificationState[] = [];
  for await (const entity of pager) {
    const parsed = notificationEntityToModel({ ...entity });
    if (parsed) states.push(parsed);
  }
  return states;
}

function parseIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
