# Indexer monitor inside the production network

Authoritative head-lag and event-gap checks run in the `indexer-monitor` App
Platform worker, inside the indexer's VPC, and reach the owner by Cloudflare
email. Neither the workstation nor Paperclip is on the path, so losing either
no longer produces missed readings or false incidents. The workstation-era
scripts (`monitorHeadLag.ts`, `monitorEventGaps.ts`) still work for manual
runs and share the same rules and audit.

## Parts

| Part                                                                                       | Where                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/productionMonitor.ts`                                                             | `indexer-monitor` worker (`.do/app.yaml`), production VPC | Every 60 s reads `indexer_cursor` (read-only transaction, 15 s statement timeout) with the read-only monitor role. A chain is lagging when its head is over 300 s behind the database clock on two consecutive checks (`headLagRules.ts`); a configured chain with no cursor row counts as over. About every 30 minutes, starting a cycle no sooner than 30 minutes after the last began, audits each chain's last 3 h of finalized history (`auditEventGaps.ts` via `eventGapAudit.ts`; one retry after 30 s). After each check it posts a verdict to the receiver. |
| `indexer-monitor` Worker (`infra/indexer-monitor`), `indexer-monitor.ekubo.org`            | Cloudflare                                                | Accepts bearer-authenticated `POST /report`, applies it to one Durable Object, and answers the two Health Check routes below. Times are the receiver's, so the worker's clock cannot make telemetry look fresh.                                                                                                                                                                                                                                                                                                                                                      |
| Health Checks `indexer-observed-fault` and `indexer-monitor-unavailable`, zone `ekubo.org` | Cloudflare                                                | HTTPS `GET`, expected code `200`, every 60 s from `ENAM` and `NEAS`, 5 s timeout, 2 retries, 2 consecutive failures to turn unhealthy, 1 success to recover.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Existing notification policy `Send email to moody`                                         | Cloudflare                                                | Emails the owner on each Health Check status change, so each episode produces one "unhealthy" and one "healthy" email.                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Only chain names and verdicts (`ok`, `gap`, `check_failed`, `read_failed`)
leave the VPC. Errors, block numbers, RPC URLs and database details stay in the
worker's logs (`doctl apps logs <app> indexer-monitor`), with RPC keys and the
connection string redacted.

## What each alert means

| Route           | Unhealthy body                                                | Meaning                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/observations` | `indexer-observed-fault head-lag=<chains> event-gap=<chains>` | A positive observation: sustained lag, or a finalized event-bearing block missing or stored under another hash. A failed or missing check never opens or clears it; the next definitive check of that chain does. |
| `/monitor`      | `indexer-monitor-unavailable head-lag=read-failing`           | The worker runs but its database read fails. Not evidence of lag.                                                                                                                                                 |
| `/monitor`      | `... head-lag=no-report`                                      | No head-lag report for 5 minutes: the worker is stopped, killed, crash-looping or cannot reach Cloudflare.                                                                                                        |
| `/monitor`      | `... head-lag=unconfigured:<chains>`                          | A report left out an expected chain (configuration drift).                                                                                                                                                        |
| `/monitor`      | `... event-gap=check-failing:<chains>`                        | No definitive audit of these chains for 75 minutes, and the latest one failed (RPC or database read). Not evidence of a gap.                                                                                      |
| `/monitor`      | `... event-gap=no-report:<chains>`                            | No audit of these chains for 75 minutes and no failure reported: the cycle is stuck, killed or overrunning.                                                                                                       |
| either          | `indexer-monitor-state-unavailable`                           | The receiver cannot read its own state. Unknown is never reported as healthy.                                                                                                                                     |

The receiver expects the 15 production chains in
`infra/indexer-monitor/src/chains.ts`; `tests/indexerMonitor.test.ts` checks
that list against `HEAD_LAG_CHAINS` in `.do/app.yaml`.

Detection, estimated from the settings above and not including email delivery
time: sustained lag about 4 minutes after the head crosses 300 s (two monitor
checks plus two failed probes); a stopped worker about 7 minutes after its
last report; a failing gap check about 77 minutes after its last good audit.

## Configuration

`indexer-monitor` in `.do/app.yaml` reads three deploy secrets
(`.github/workflows/deploy.yaml`), all required by the fail-closed `envsubst`:

- `MONITOR_PG_CONNECTION_STRING`: private-network connection string of the
  existing read-only monitor role. It also overrides `PG_CONNECTION_STRING` for
  this component, so the container never holds the indexer's write credential.
- `MONITOR_REPORT_TOKEN`: random token, also set as the Worker secret
  `REPORT_TOKEN`.
- `GAP_MONITOR_CHAINS`: the audit's RPC list, `network=url[|maxRange]`, the same
  endpoints and range caps the workstation monitor used.

Optional: `HEAD_LAG_THRESHOLD_SECONDS` (300), `HEAD_LAG_SUSTAIN_CHECKS` (2),
`HEAD_LAG_INTERVAL_SECONDS` (60), `GAP_MONITOR_WINDOW_SECONDS` (10800),
`GAP_MONITOR_INTERVAL_MINUTES` (30), `GAP_MONITOR_RETRY_SECONDS` (30).

## Deploying the receiver

`infra/indexer-monitor` is a standalone package with its own lockfile; the
indexer's App Platform workflow does not build or deploy it. From that
directory:

```sh
npm ci
npx tsc -p .
XDG_CONFIG_HOME=$HOME/.config npx cf deploy --dry-run --profile ekubo_inc
XDG_CONFIG_HOME=$HOME/.config npx cf deploy --profile ekubo_inc   # under the production gate
```

`--mode canary` deploys `indexer-monitor-canary.ekubo.org` with its own state
and token. It expects a single chain named `canary` on both checks, for alert
drills with synthetic reports that never touch production state.

## Cutover

1. Deploy the canary and two temporary Health Checks against it. Drive it with
   synthetic reports: healthy; lag on two reports then clean; a gap then clean;
   `read_failed` then silence; a gap `check_failed` past 75 minutes. Confirm one
   unhealthy and one healthy email for each episode, and the transition
   records in `cf alerting history list`.
2. Deploy the production receiver, set its token, add the deploy secrets, then
   merge so the existing workflow deploys `indexer-monitor`. Confirm healthy
   reports on all 15 chains and results matching the workstation monitors for
   the same period.
3. Stop and disable `indexer-head-lag-monitor.timer` and
   `indexer-gap-monitor.timer`, then remove their environment files, which hold
   the workstation's copy of the monitor role's credential. The role itself is
   shared with other read-only consumers and is not removed.

## Rollback

Before cutover the workstation timers keep running. If the new path misfires,
suspend its two Health Checks; the worker can be removed by reverting its
`.do/app.yaml` entry. After cutover, fix forward or redeploy the last verified
Worker or image; do not restore workstation database access as the steady
state. The App Platform `DEPLOYMENT_FAILED`, restart, CPU and memory alerts
continue to cover the worker itself.

## Residual risks

- A Cloudflare Health Check, notification or email outage at the same time as
  an indexer fault goes unreported; the existing public endpoint checks share
  that dependency.
- One email recipient. While Paperclip is down the email creates no Paperclip
  work; reconcile the episode when it is back.
- The receiver's routes are public and reveal only chain names in a fault.
