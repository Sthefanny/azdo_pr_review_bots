# PR Review Health Bot (Azure DevOps + Slack)

This service helps teams keep pull request reviews healthy **without spamming a shared Slack channel**.
It combines **team-focused channel summaries** (via Slack Incoming Webhooks) with **personal updates in Slack DMs** (via a Slack bot).

## Overview

- Runs as **Azure Functions**: **three timers** (daily debt, leaderboard, subscriptions) plus **matching HTTP endpoints** so you can run each job separately.
- Loads **multi-team** settings from `config/config.json` (with `${ENV_VAR}` interpolation).
- Reads Azure DevOps REST APIs for active/completed PRs, reviewers, threads, statuses, and branch policies.
- Persists state in **Azure Table Storage** (snapshots, subscriptions, schedules, DM dedupe).
- Sends **channel summaries only on each team’s configured schedule**.
- Sends **DMs when subscription-relevant events occur** (not on every timer tick unless something changed).

High-level architecture (each runnable job acquires **its own** storage lease):

```
Trigger (timer or POST) → load config → acquire lease for that job
  → for each enabled team, run only the slices that job owns (see Split jobs below)
```

## Feature 1 — Daily Review Debt Summary

Neutral, team-focused snapshot of review debt:

- Open PRs waiting for review (non-draft, optional “ready for review” label filter)
- Counts PRs **past SLA** with **no Azure DevOps reviewer vote** yet (comment threads alone don’t count as a vote)
- Oldest waiting duration, weekly averages (best-effort from stored metrics)
- PRs blocked by configured **relevant** failing checks or unresolved comment threads
- Optional “missing required approvals” hints from **Azure DevOps branch policies** (minimum reviewers policy)

## Feature 2 — Weekly Healthy Review Leaderboard

Positive-only recognition:

- Top reviewers by **distinct PRs** where they reviewed (approved **or** commented), excluding the PR author
- Team stats for the lookback window
- Optional special callouts (fastest first review, most comments, most approvals)
- Optional **Giphy “winner treat”**: if `leaderboard.giphyApiKeyEnvVar` is set and the week’s **#1 reviewer** exists, the weekly Slack post includes a **random celebration/thanks GIF** (`rating=g`) from the [Giphy API](https://developers.giphy.com/docs/api/)

## Feature 3 — Personal PR Subscriptions (automatic)

Automatic Slack IDs are derived from `slack.userMapping` (email → Slack user id).

Users are subscribed when they are the **author**, a **reviewer (non-`none` vote)**, or a **commenter**.

DM triggers (deduped):

- New comment / resolved thread
- Relevant check failed / recovered after failure
- Approval votes fingerprint change
- Merge conflicts newly detected
- PR completed or abandoned
- New source commit after prior reviewer activity

Rules:

- Build failure & merge conflict DMs default to **author only** (configurable).
- Channel webhooks are **never** used for personal notifications.

## Azure DevOps PAT

Create a PAT with **read** access sufficient for:

- Code (Git): read pull requests, threads, statuses, policies
- (Optional) **Identity / Profile** if you later extend mapping beyond config

Never commit PATs; reference them via `patEnvVar` per team.

## Split jobs (timers + HTTP)

Three registrations share the workload — each acquires **its own** lease so jobs do not block each other.

| Registered name | Lease row (`partition` `__singleton`) | Work |
|-----------------|---------------------------------------|------|
| `dailyReviewDebtTimer` | `timer-lock-review-debt` | Active PR snapshots, daily Slack summary when cron says so |
| `weeklyLeaderboardTimer` | `timer-lock-leaderboard` | Completed PRs only → weekly leaderboard when due |
| `personalSubscriptionsTimer` | `timer-lock-subscriptions` | Snapshots + auto-subscriptions table + Slack DMs |

**HTTP triggers** (same workloads; `POST` + function auth key):

- `review-health/daily-review-debt` → `dailyReviewDebtHttp`
- `review-health/weekly-leaderboard` → `weeklyLeaderboardHttp`
- `review-health/personal-subscriptions` → `personalSubscriptionsHttp`

Local example (defaults to `/api/` prefix):

```bash
curl -X POST "http://localhost:7071/api/review-health/daily-review-debt?code=<your_function_key>"
```

Use `func azure functionapp function keys …` / portal on Azure.

**Timer schedules** (NCRONTAB, 6 fields):

- `TIMER_SCHEDULE_DAILY_REVIEW_DEBT` — default `0 0 9 * * 1-5`
- `TIMER_SCHEDULE_WEEKLY_LEADERBOARD` — default `0 0 10 * * 5`
- `TIMER_SCHEDULE_PERSONAL_SUBSCRIPTIONS` — default every 15 minutes `0 */15 * * * *`

If you previously deployed the combined timer, you may still have an old lease row **`timer-lock`** in the schedule table — safe to delete after migration.

## Slack setup

### Incoming Webhook (channel summaries)

1. Create an Incoming Webhook for the target channel.
2. Store the webhook URL in an environment variable referenced by `slack.webhookEnvVar`.

Channel summaries post **`text`** plus top-level Block Kit **`blocks`**. Wrapping the same payload in **`attachments`** (the only way to get the colored sidebar on legacy incoming webhooks) often makes Slack collapse the card behind **“Show more”**, so the bot uses top-level blocks only. `attachmentColor` in the code is a **severity hint** for logs only.

**Weekly winner GIF (optional):** Add e.g. `"giphyApiKeyEnvVar": "GIPHY_API_KEY"` under **`leaderboard`** in `config.json`, create an app key at [Giphy Developers](https://developers.giphy.com/), and set that env var on the Function App. Omit **`giphyApiKeyEnvVar`** to disable. GIFs are not fetched during **`DRY_RUN`**.

**Unresolved comment threads:** Counts follow Azure DevOps **threads** on the PR. The bot excludes **system** comments and threads where only **Qodo** (bot/tool) commented. Qodo is not treated as a human reviewer in leaderboards.

### Slack Bot (DMs)

1. Create a Slack app with a **Bot User OAuth Token** (`xoxb-...`).
2. Recommended OAuth scopes:
   - `chat:write`
   - `im:write`
   - `users:read`
   - (Optional later) `users:read.email` if you implement `users.lookupByEmail`
3. Install the app to your workspace and put the token in `slack.botTokenEnvVar`.

### User mapping

Provide `slack.userMapping` as `azureDevOpsEmail → slackUserId`.
If a mapping is missing, the bot **logs a warning and skips** that DM target.

## Azure Function setup

1. Create a **Node.js 20** Function App (Functions v4).
2. Application settings (minimum):
   - `AzureWebJobsStorage` — storage account connection string
   - `AzureWebJobsFeatureFlags` = `EnableWorkerIndexing` (Node v4 programming model)
   - `FUNCTIONS_WORKER_RUNTIME` = `node`
   - **Timer schedules** — `TIMER_SCHEDULE_DAILY_REVIEW_DEBT`, `TIMER_SCHEDULE_WEEKLY_LEADERBOARD`, `TIMER_SCHEDULE_PERSONAL_SUBSCRIPTIONS`
   - `TIMER_RUN_ON_STARTUP` — optional; set `true` locally so **each registered timer** also runs once on host start (use cautiously—multiple leases).
   - `PR_BOT_TABLE_NAME`, `PR_BOT_SUBSCRIPTIONS_TABLE_NAME`, `PR_BOT_SCHEDULE_STATE_TABLE_NAME`, `PR_BOT_NOTIFICATION_STATE_TABLE_NAME`
   - Per-team secrets referenced from `config/config.json`
3. Deploy contents: `host.json`, `package.json`, `node_modules`, `dist/`, `config/config.json`.

Pipeline reference: see `azure-pipelines.yml` (uses `azureSubscription` and `functionAppName` variables).

## Azure Table Storage

Four logical tables (names configurable via env vars):

| Table | Purpose |
|------|---------|
| `PR_BOT_TABLE_NAME` | Latest `PullRequestSnapshot` per team/PR |
| `PR_BOT_SUBSCRIPTIONS_TABLE_NAME` | Auto (future: manual) subscriptions |
| `PR_BOT_SCHEDULE_STATE_TABLE_NAME` | Last successful channel post timestamps + timer lease row |
| `PR_BOT_NOTIFICATION_STATE_TABLE_NAME` | DM dedupe hashes |

The lease rows live under partition **`__singleton`**, one per job — e.g. **`timer-lock-review-debt`**, **`timer-lock-leaderboard`**, **`timer-lock-subscriptions`**.

## config.json (one team)

Copy `config/config.json.example` → `config/config.json` and replace placeholders.

`config/config.json` and `local.settings.json` are **gitignored** — keep real org/team names, emails, and env-only secrets there; use the **`.example`** files in the repo as generic templates only.

- Secrets **must** be environment variables (`patEnvVar`, `webhookEnvVar`, `botTokenEnvVar`).
- Non-secret values may use `${ENV_VAR}` interpolation (e.g. repository IDs).
- **`azureDevOps.activePullRequestCreatedWithinDays`** (optional): only **active** PRs **created** in the last _N_ days (rolling, UTC) are loaded and summarized. Drops API + snapshot work on large repos. **Omit in production** if you must track stale open PRs or full subscription/DM coverage. Example: `7` matches a “última semana” slice for metrics (not merged PRs—that’s **`leaderboard.lookbackDays`**).

## config.json (multiple teams)

Add additional objects under `teams`. Each team may target a different AzDO org/project/repo and Slack credentials.

## Environment variables

**Application (shared)**

| Variable | Purpose |
|----------|---------|
| `AzureWebJobsStorage` | Storage connection string |
| `PR_BOT_TABLE_NAME` | Snapshot table |
| `PR_BOT_SUBSCRIPTIONS_TABLE_NAME` | Subscriptions table |
| `PR_BOT_SCHEDULE_STATE_TABLE_NAME` | Schedule + lease table |
| `PR_BOT_NOTIFICATION_STATE_TABLE_NAME` | DM dedupe table |
| `TIMER_SCHEDULE_DAILY_REVIEW_DEBT` | `dailyReviewDebtTimer` (default `0 0 9 * * 1-5`) |
| `TIMER_SCHEDULE_WEEKLY_LEADERBOARD` | `weeklyLeaderboardTimer` (default `0 0 10 * * 5`; **day 0=Sunday** per NCRONTAB) |
| `TIMER_SCHEDULE_PERSONAL_SUBSCRIPTIONS` | `personalSubscriptionsTimer` (default `0 */15 * * * *`) |
| `TIMER_RUN_ON_STARTUP` | Set `true` **locally** so registered timers fire once at host startup |
| `IMMEDIATE_SCHEDULE_SUMMARIES` | If `true`, both **daily review-debt** and **weekly leaderboard** jobs skip cron and post every run (**testing**) — shorthand for enabling both |
| `IMMEDIATE_DAILY_REVIEW_DEBT` | Split daily job only: bypass cron (**testing**) |
| `IMMEDIATE_WEEKLY_LEADERBOARD` | Split leaderboard job only: bypass cron (**testing**) |
| `PR_SNAPSHOT_CONCURRENCY` | Parallel ADO round-trips while building **active PR** snapshots (default `8`, max `32`) |
| `LEADERBOARD_ADO_CONCURRENCY` | Parallelism for **completed PR** thread/detail fetches used by the leaderboard (defaults to `PR_SNAPSHOT_CONCURRENCY`) |
| `DRY_RUN` | `true` skips Slack posts/DMs |
| `DRY_RUN_SAVE_STATE` | When `DRY_RUN=true`, set `false` to skip table writes |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

**Per-team (examples)**

- Repository ids, PATs, Slack webhook URLs, bot tokens — as referenced in `config/config.json`.

## Run locally (Azure Functions Core Tools)

```bash
cp local.settings.json.example local.settings.json
cp config/config.json.example config/config.json
# fill env vars + config
npm install
npm run build
npm start
```

After `npm run build`, the compiled entry file is **`dist/index.js`**. The `package.json` field `"main"` must point there (not `dist/src/index.js`).

If `AzureWebJobsStorage` is **`UseDevelopmentStorage=true`**, run the **Azurite** emulator locally (or otherwise provide a working storage endpoint); otherwise the host reports `Unable to access AzureWebJobsStorage`. Install: `npm i -g azurite`, then in another terminal run `azurite` before `func start`.

> Requires [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

## Dry-run mode

```
DRY_RUN=true DRY_RUN_SAVE_STATE=false npm start
```

_logs intended Slack payloads; skips HTTP calls to Slack and (optionally) all table writes._

### Immediate Slack summaries (testing only)

Set `IMMEDIATE_SCHEDULE_SUMMARIES=true` **or** `IMMEDIATE_DAILY_REVIEW_DEBT` / `IMMEDIATE_WEEKLY_LEADERBOARD` to post channel summaries without waiting for cron (**testing only**).

Without `TIMER_RUN_ON_STARTUP=true`, each timer waits for its own NCRONTAB after `func start`.

## Azure DevOps pipeline

See `azure-pipelines.yml`.

Set pipeline variables:

- `azureSubscription` — service connection name
- `functionAppName` — target Function App
- `nodeVersion` — default `20.x`

The deploy stage is skipped automatically when `functionAppName` is empty.

## Example Slack channel messages

Channel summaries use **Slack Block Kit** (headers, columns, dividers, emoji) as **`text` + top-level `blocks`**. There is no colored sidebar (that requires `attachments`, which tends to trigger **“Show more”** collapse). Hue in code (green / blue / amber by load) is for dry-run logs only.

Rough structure:

- **Daily:** header (chart + team), context line, metric “cards” (four fields), SLA + flow sections, “Needs attention” list with PR links.
- **Weekly:** trophy **header** (large), then two **context** lines (same small meta style as before): rolling-window stats, then thank-you; top reviewers, stats grid, shout-outs.

Older plain-text examples (for reference):

```text
PR review · Your Team — N open, M blocked by checks
… (full layout is block-based in the client)
```

## Example Slack DMs

- `Your PR build failed: …` + failing check name
- `New comment on a PR you follow: …`
- `PR merged: …`

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| 401/403 from Azure DevOps | PAT scopes or expired PAT |
| Webhook 400 errors | Payload too large — lower `maxNeedsAttentionItems`; very long PR titles are truncated. Check Slack’s Block Kit limits (~50 blocks). |
| No DMs | Missing `slack.userMapping`, bot not installed, or missing OAuth scopes |
| Duplicate channel posts | Verify team timezone + cron strings; check `PR_BOT_SCHEDULE_STATE_TABLE_NAME` rows |
| No Slack after `func start` | By default timers wait for NCRONTAB; set `TIMER_RUN_ON_STARTUP=true` locally, or `POST` an HTTP trigger, or enable an `IMMEDIATE_*` flag for testing |
| Run shows **Failed** after Ctrl+C | Interrupting the host aborts the invocation — wait until `Executed ... Succeeded`. First runs can take **minutes** (many PRs + Azure DevOps); channel webhooks run **after** PR data is loaded |
| Slow runs / many open PRs | Use **split jobs** so leaderboard does not wait on active PR scans; set `azureDevOps.activePullRequestCreatedWithinDays`; raise `PR_SNAPSHOT_CONCURRENCY` |
| `Worker was unable to load entry point "dist/src/index.js"` | Run `npm run build`; `package.json` `"main"` must be `dist/index.js` (matches `rootDir: "src"` / `outDir: "dist"`) |
| `Unable to access AzureWebJobsStorage` / storage health Unhealthy | With `UseDevelopmentStorage=true`, start **Azurite** or switch to a real storage account connection string |

## Security notes

- Rotate PATs and Slack tokens regularly.
- Table storage connection strings grant broad access — scope storage firewall / RBAC.
- Logs redact Slack tokens heuristically; still avoid logging raw URLs containing secrets.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run watch` | `tsc --watch` |
| `npm start` | `func start` |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit tests |
| `npm run typecheck` | `tsc --noEmit` |
