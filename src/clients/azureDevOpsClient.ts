/** Minimal Azure DevOps REST client for Pull Requests Git APIs. */

import type { TeamConfig } from "../config/configSchema.js";
import type { Logger } from "../utils/logger.js";

const DEFAULT_API_VERSION = "7.1";

export interface AdoIteration {
  id: number;
  description?: string;
  createdDate?: string;
}

export interface AdoReviewerRaw {
  displayName?: string;
  uniqueName?: string;
  id?: string;
  vote?: number;
  isFlagged?: boolean;
}

export interface IdentityRef {
  displayName?: string | undefined;
  uniqueName?: string | undefined;
  id?: string | undefined;
  descriptor?: string | undefined;
}

export interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  status?: "active" | "completed" | "abandoned" | string | undefined;
  isDraft?: boolean | undefined;
  creationDate?: string | undefined;
  closedDate?: string | null | undefined;
  createdBy?: IdentityRef | undefined;
  sourceRefName?: string | undefined;
  targetRefName?: string | undefined;
  lastMergeSourceCommit?: { commitId?: string | undefined } | undefined;
  reviewers?: AdoReviewerRaw[] | undefined;
  labels?: { name?: string | undefined }[] | undefined;
  mergeStatus?: string | undefined;
}

export interface PolicyConfiguration {
  id?: number;
  type?: {
    displayName?: string;
    url?: string;
    id?: string;
  };
  isEnabled?: boolean;
  settings?: Record<string, unknown>;
  /** branch filter */
  refName?: string;
}

interface ThreadComment {
  id?: number;
  parentCommentId?: number;
  commentType?: string;
  deletedDate?: string;
  content?: string;
  publishedDate?: string;
  author?: { displayName?: string; uniqueName?: string; descriptor?: string };
}

export interface ThreadEntity {
  id?: number;
  status?: number | string | undefined;
  isDeleted?: boolean;
  comments?: ThreadComment[];
}

export interface StatusEntity {
  id?: unknown;
  state?: unknown;
  name?: unknown;
  context?: { genre?: unknown; name?: unknown };
}

export interface AzureDevOpsClientOptions {
  team: TeamConfig["azureDevOps"];
  logger: Logger;
  personalAccessToken: string;
}

export class AzureDevOpsClient {
  private readonly repoBase: string;

  private readonly policyBase: string;

  constructor(private readonly opts: AzureDevOpsClientOptions) {
    const org = encodeURIComponent(opts.team.organization);
    const project = encodeURIComponent(opts.team.project);
    const repo = encodeURIComponent(opts.team.repositoryId);
    const root = `https://dev.azure.com/${org}/${project}`;
    this.repoBase = `${root}/_apis/git/repositories/${repo}`;
    this.policyBase = `${root}/_apis/policy/configurations`;
  }

  /** Public PR HTML URL for Slack / browser */
  pullRequestHtmlUrl(team: TeamConfig["azureDevOps"], pullRequestId: number): string {
    const org = encodeURIComponent(team.organization);
    const project = encodeURIComponent(team.project);
    const slug = encodeURIComponent(team.repositoryName ?? team.repositoryId);
    return `https://dev.azure.com/${org}/${project}/_git/${slug}/pullrequest/${pullRequestId}`;
  }

  private authHeader(): string {
    const token = this.opts.personalAccessToken.trim();
    return `Basic ${Buffer.from(`:${token}`).toString("base64")}`;
  }

  private async getJson(path: string, query: Record<string, string | number | undefined> = {}) {
    const params = new URLSearchParams({
      apiVersion: DEFAULT_API_VERSION,
    });
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      params.set(k, String(v));
    }

    const url = `${path}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: this.authHeader(), Accept: "application/json" },
    });

    if (!res.ok) {
      const text = await safeText(res);
      this.opts.logger.error(`Azure DevOps request failed (${res.status}) ${path}: ${text}`);
      throw new Error(`ADO ${res.status} for ${path}`);
    }
    const json: unknown = await res.json();
    return json;
  }

  async listPullRequests(params: {
    status: string;
    minCreated?: Date | undefined;
    top?: number;
  }): Promise<AdoPullRequest[]> {
    const qp: Record<string, string | number | undefined> = {
      "searchCriteria.status": params.status,
      "$top": params.top ?? 200,
    };
    if (params.minCreated) {
      qp["searchCriteria.queryTimeRangeType"] = "created";
      qp["searchCriteria.minTime"] = params.minCreated.toISOString();
    }

    const json = (await this.getJson(`${this.repoBase}/pullrequests`, qp)) as { value?: AdoPullRequest[] };
    const list = json.value ?? [];
    if (!params.minCreated) return list;
    return list.filter((pr) =>
      typeof pr.creationDate === "string" ? new Date(pr.creationDate) >= params.minCreated! : true,
    );
  }

  /** Completed PR's since minClosed (best-effort filtering). ADO filtering varies with query options. */
  async listRecentlyClosedPullRequests(params: {
    minClosedUtc: Date;
    top?: number | undefined;
  }): Promise<AdoPullRequest[]> {
    const qp: Record<string, string | number | undefined> = {
      "searchCriteria.status": "completed",
      "$top": params.top ?? 200,
      "searchCriteria.queryTimeRangeType": "closed",
      "searchCriteria.minTime": params.minClosedUtc.toISOString(),
    };
    try {
      const json = (await this.getJson(`${this.repoBase}/pullrequests`, qp)) as {
        value?: AdoPullRequest[];
      };
      const list = json.value ?? [];

      const minMs = params.minClosedUtc.getTime();
      return list.filter((pr) => {
        const closedMs = typeof pr.closedDate === "string" ? Date.parse(pr.closedDate) : NaN;
        return Number.isFinite(closedMs) && closedMs >= minMs - 120_000;
      });
    } catch {
      // Fallback scan without filtering if unsupported
      const all = await this.listPullRequests({ status: "completed", top: 1000 }).catch(() => []);
      const minMs = params.minClosedUtc.getTime();
      return all.filter((pr) => typeof pr.closedDate === "string" && Date.parse(pr.closedDate) >= minMs - 120_000);
    }
  }

  async getPullRequest(pullRequestId: number): Promise<AdoPullRequest> {
    const json = (await this.getJson(`${this.repoBase}/pullrequests/${pullRequestId}`)) as AdoPullRequest;
    return json;
  }

  async getIterations(pullRequestId: number): Promise<AdoIteration[]> {
    const json = (await this.getJson(`${this.repoBase}/pullrequests/${pullRequestId}/iterations`)) as {
      value?: AdoIteration[];
    };
    return json.value ?? [];
  }

  async getThreads(pullRequestId: number): Promise<ThreadEntity[]> {
    const json = (await this.getJson(`${this.repoBase}/pullrequests/${pullRequestId}/threads`)) as {
      value?: ThreadEntity[];
    };
    return json.value ?? [];
  }

  async listStatuses(pullRequestId: number): Promise<StatusEntity[]> {
    const json = (await this.getJson(`${this.repoBase}/pullrequests/${pullRequestId}/statuses`)) as {
      value?: StatusEntity[];
    };
    return json.value ?? [];
  }

  async loadBranchPolicies(params?: { repositoryId?: string; refName?: string }): Promise<PolicyConfiguration[]> {
    const query: Record<string, string | number | undefined> = {};
    if (params?.repositoryId) query.repositoryId = params.repositoryId;
    if (params?.refName) query.refName = params.refName;

    const json = (await this.getJson(this.policyBase, query)) as { value?: PolicyConfiguration[] };

    return json.value ?? [];
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

