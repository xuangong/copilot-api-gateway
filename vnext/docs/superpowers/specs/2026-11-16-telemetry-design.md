# Telemetry: external systems push hourly metrics to the gateway

Status: implemented on branch `feat/telemetry` (2026-11-17).

## Motivation

The owner runs a trojan proxy on an Azure VM. In November 2026 its egress grew sharply, the subscription hit its spending limit and the VM was stopped. Finding where the traffic went required manual log analysis over SSH. The owner wants to see, without logging in to the VM:

- where the bulk of the traffic goes (by proxy user and destination domain),
- whether traffic is surging,
- month-to-date usage and a month-end projection against a limit.

Data freshness of one hour is enough. The data is operational telemetry, not secret.

The feature is a general pattern: the gateway hosts hourly metrics pushed by any external system. The trojan VM is the first source.

## Decisions

- **Generic hourly time series.** Sources push `{metric, hour, dims, value, unit}`; the gateway stores, analyses and displays them without knowing the source system. Adding a system needs a key and a script, no gateway change.
- **Push, not pull.** A script on the source pushes to the gateway; no inbound port is opened on the source.
- **Hour replacement.** A push replaces every (metric, hour) it contains, so retries and recomputation never double-count and a dimension value that drops out of a top-N does not linger.
- **Dashboard only.** No email or chat notifications. Surges and over-limit projections are highlighted in the dashboard. (The owner should also set an Azure budget alert, which is billing-accurate.)
- **Owner-only.** Sources, data and settings are visible and manageable only by the owning user; administrators get no override.
- **The push key can only push.** It cannot read data or authenticate anywhere else.
- **First source: trojan VM**, via an agent script distributed through GitHub Releases with a one-line installer. The agent also checks once per hour that the trojan service works end to end, so availability is reported through the same channel.

## Data model

Metric point:

| field | rule |
| --- | --- |
| `metric` | `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`, 1..64 chars |
| `hour` | ISO 8601 UTC at the top of an hour, e.g. `2026-11-16T13:00:00Z` |
| `dims` | object, 0..3 entries; keys like `metric` segments (1..32 chars); values strings 1..256 chars |
| `value` | finite number ≥ 0 |
| `unit` | `bytes`, `count` or `ms` |

D1 tables (migration shared by D1 and SQLite):

- `telemetry_sources`: `id` (`tls_` + 32 hex), `owner_id`, `name` (1..64), `key_hash` (SHA-256 hex of the push key, UNIQUE), `settings_json`, `created_at`, `last_push_at`.
- `telemetry_points`: `source_id`, `metric`, `hour` (unix seconds), `dims_key` (canonical JSON of sorted dims, `""` when none), `dims_json`, `value`, `unit`; primary key `(source_id, metric, hour, dims_key)` (its prefix serves per-metric hour ranges), plus two partial indexes on `hour` (`WHERE dims_key <> ''` and `WHERE dims_key = ''`), one per retention class.
- `telemetry_hourly`: `source_id`, `metric`, `hour`, `unit`, `value` (sum over dims); primary key `(source_id, metric, hour)`, index on `hour`. It is rewritten in the same atomic batch as a push, and serves totals, first hours, the metric list, budget and surge reads so that no page view scans dimension rows. Grouped series, top, contributors and non-zero flags read dimension rows by primary key range only.

Retention, enforced by the existing scheduled maintenance:
- points with dims: 90 days;
- points without dims: 400 days;
- hourly rollup rows: 400 days.

Expiry runs on every maintenance sweep, each class through its own index; only the orphan scan runs once an hour (UTC minute 17, and again while the previous scan used up its budget).

Deleting a source removes the source; its points are purged by scheduled maintenance shortly after (in bounded chunks over one or more sweeps). Configuration export/import does not include telemetry.

Push key: `tlm_` + 64 hex, shown once at creation or rotation; only its hash is stored.

## Push API

`POST /api/telemetry/push`, mounted before session auth.

- `Authorization: Bearer tlm_<64 hex>` (scheme case-insensitive). Unknown, malformed or deleted-source keys and disabled owners all return `401 invalid_key`. A `tlm_` bearer is rejected by every other route (like `sds_`).
- Body ≤ 2 MiB, `{ "version": 1, "points": [ … ] }`, at most 20 000 points and 20 distinct metrics (so one push stays within D1's per-invocation query limit). Validation failures return `400 invalid_request`. Points older than the retention for their kind or more than one hour in the future are rejected (`400 invalid_request`).
- For each distinct (metric, hour) in the body, existing rows for that source, metric and hour are deleted and the pushed rows inserted, atomically per push. Duplicate (metric, hour, dims) within one body → `400 invalid_request`.
- `last_push_at` is updated.
- `200 { "accepted": <points> }`. All responses `Cache-Control: no-store`; bodies and headers are not logged.

## Management and query API

Session-guarded (same guard as sync device management; owner-only, admins get `404 source_not_found` for others' sources):

- `GET /api/telemetry/sources` → list with `id, name, createdAt, lastPushAt, settings`.
- `POST /api/telemetry/sources` `{ name }` → `201 { source, key, install }` where `install` is the ready-to-run agent install command for this gateway origin and key. Max 16 sources per owner (`409 source_limit`).
- `PATCH /api/telemetry/sources/:id` `{ name?, settings? }`.
- `POST /api/telemetry/sources/:id/rotate-key` → `{ key, install }`.
- `DELETE /api/telemetry/sources/:id`.
- `GET /api/telemetry/sources/:id/metrics` → metric names, units, dim keys, first/last hour.
- `GET /api/telemetry/sources/:id/series?metric=&from=&to=&groupBy=&top=` → hourly buckets, optionally split by one dim (top N, rest as `(other)`).
- `GET /api/telemetry/sources/:id/top?metric=&from=&to=&groupBy=&limit=` → totals per dim value, share, and change versus the previous period of equal length.
- `GET /api/telemetry/sources/:id/summary` → freshness, month-to-date and projection for the budget metric, surges and non-zero flags in the last 7 days, and the latest check per check metric.

## Analysis

Settings (`settings_json`), all optional:

| setting | meaning | default |
| --- | --- | --- |
| `budgetMetric` | metric for month-to-date and projection | none |
| `monthlyLimit` | limit in the metric's unit | none |
| `pricePerGB`, `freeGB` | cost conversion for `bytes` metrics | none |
| `surgeMetrics` | metrics checked for surges | all metrics except `ms` metrics, summed over dims |
| `surgeFactor` | multiple of baseline | 3 |
| `surgeMinBytes`, `surgeMinCount` | minimum hourly value to flag | 2 GiB, 1000 |
| `flagNonZeroMetrics` | metrics where any non-zero hour is flagged (e.g. `probe.fail`) | none |
| `checkMetrics` | metrics that are single point-in-time check results, 1 = passed, 0 = failed (e.g. `probe.ok`) | none |
| `labels` | display names per dim key and value, e.g. `{ "user": { "#1": "MacBook" } }` | none |
| `staleAfterHours` | freshness warning threshold | 2 |

- **Month-to-date** sums the budget metric (over all dims) from the first hour of the current UTC month to now. **Projection** = month-to-date + (average daily total of the last 7 complete days) × remaining days in the month. Cost = max(0, GB − freeGB) × pricePerGB.
- **Surge**: for each surge metric (summed over dims) and each hour in the window, baseline = average hourly value over the preceding 7 × 24 hours (hours without data count as 0). Flag when value ≥ factor × baseline and value ≥ the minimum for its unit. An hour is judged only if the metric has at least 24 hours of history before it (otherwise the backfill after a fresh install, whose missing history counts as 0, would flag every hour). Metrics with unit `ms` are not checked for surges. Each surge reports the top 5 dim contributions for that hour.
- **Non-zero flags**: every hour in which a metric listed in `flagNonZeroMetrics` (summed over dims) is above zero is flagged, with its dim breakdown (e.g. the failing probe stage).
- **Point-in-time checks**: for metrics in `checkMetrics`, each hour is `passed` (value > 0), `failed` (value = 0), `no check` (no point, at or after the metric's first point) or `not monitored` (before the metric's first point). `no check` is a warning: the VM may have been down or the agent not running. No availability percentage or uptime is ever computed or shown for them: one check per hour says nothing about the rest of the hour. Timing assumption: the agent probes once per run and attributes the probe to the hour containing the run time (the timer fires at about :05), so the check point of the latest closed hour exists by the time that hour is judged; a missing point there is a real `no check`.
- **Freshness**: stale when `now − last_push_at > staleAfterHours`.

Computed on read with grouped SQL; a page view issues a small, bounded number of queries.

## Dashboard

A "Telemetry" page lists the owner's sources (name, last push, stale badge). Creating a source shows the push key and install command once, with Copy.

Source page, top to bottom:
1. Freshness: last push; a prominent warning when stale ("no data for N hours — the VM may be stopped or the agent failing").
   If the latest closed hour has `no check` for a check metric, show a warning ("no check during 13:00–14:00 — the VM may be down or the agent not running") alongside the staleness warning.
   Latest check for each `checkMetrics` metric, worded as a single check, e.g. "One check during 13:00–14:00: passed (this reflects only the moment of the check)", and on failure the failing stage from the matching `flagNonZeroMetrics` breakdown.
2. Month-to-date and projection for the budget metric: progress bar against the limit, red when the projection exceeds it; cost when configured.
3. Hourly chart: metric and range (24 h / 7 d / 30 d), optionally one line per dim value (top 10 + other) plus a dashed total line, surge hours highlighted. A `checkMetrics` metric is drawn as per-hour markers (passed / failed / no check as a warning / not monitored as neutral), never as a percentage.
4. Top table: group by a dim, value, share, change versus the previous period.
5. Flagged hours: surges (hour, metric, value, baseline, ratio, top 5 contributors) and non-zero flags (hour, metric, dim breakdown).
6. Settings form (all settings above, including dim labels), rename, rotate key, delete.

Units render as bytes (KB/MB/GB), counts or milliseconds. All copy in EN and ZH.

## Trojan agent

`trojan-telemetry.py` (Python 3 standard library only) runs on the VM as root from a systemd timer (`OnCalendar=*-*-* *:05:00`, `Persistent=true`), with a file lock.

Configuration `/etc/trojan-telemetry.env` (mode 600): `TELEMETRY_GATEWAY`, `TELEMETRY_KEY`, `TROJAN_CONTAINER` (default `trojan`), `TELEMETRY_IFACE` (default `eth0`), `TROJAN_USERS` (ordered list of user hashes → `#1`, `#2`, …; default derived from the trojan-go config's password order when readable), `TOP_DOMAINS` (default 50), `TROJAN_SNI`, `PROBE_HOST` (default: the interface's public address via the configured SNI host), `PROBE_TARGET`, `PROBE_TIMEOUT`. The probe password is read from the trojan-go config and never leaves the VM.

State `/var/lib/trojan-telemetry/`: `cursor.json` (last fully processed hour), `outbox/<YYYY-MM-DDTHH>.json` (computed, unpushed hours).

Each run:
1. **Compute** every closed hour after the cursor, up to the last closed hour:
   - trojan: parse `docker logs --since/--until` for that hour; lines `user <hash> … tunneling to <host>:<port> closed sent: <n> <unit> recv: <n> <unit>`; aggregate by user and domain (registrable domain; IPs kept as-is) into `proxy.sent_bytes` (downloads: sent to the client), `proxy.recv_bytes` (uploads: received from the client), their sum `proxy.total_bytes` (agent 1.0.2) and `proxy.connections`; keep the top `TOP_DOMAINS` domains per user by total bytes and fold the rest into `(other)`; unknown user hashes map to `#?`.
   - NIC: `vnstat --json h` for that hour → `nic.tx_bytes`, `nic.rx_bytes` and their sum `nic.total_bytes` (no dims).
   - Write the hour to the outbox, then advance the cursor. On first run the cursor starts at the current hour minus 24 h (bounded by available logs).
   - Availability probe (once per run, attributed to the hour containing the run time and written to the outbox as its own entry): open TCP to the VM's public address on 443, TLS with SNI `TROJAN_SNI` (default `trojan.xianliao.de5.net`, certificate verified), send a trojan CONNECT request with the first configured password to `PROBE_TARGET` (default `www.gstatic.com:80`), send `GET /generate_204`, and expect an HTTP 204 within `PROBE_TIMEOUT` (default 15 s). Metrics: `probe.ok` (1 or 0), `probe.fail` (1 with dim `stage` = `tcp`, `tls`, `tunnel`, `http` or `timeout`, or absent on success), `probe.latency_ms` (total time of a successful probe). Hours computed during catch-up get no probe points; a past hour cannot be probed.
2. **Push** outbox files oldest first, up to 24 hours per request. Delete each file after a `200`. On a `400`/`413` for a batch (of any size) the agent sends a **canary**: the newest hour that has a computed hourly file alone (else the newest hour; the open hour usually holds only probe points), at most once per run. If the canary is refused too, the gateway refuses everything (bad scope, limits, a VM clock more than about 1 h ahead of the gateway, which rejects points more than 1 h in the future): the run stops, quarantines nothing, keeps every file and exits non-zero, so a fully refusing gateway costs at most 2 requests per run. If the canary is accepted the gateway is healthy: the refused batch is bisected (halves are pushed, accepted halves deleted, refused halves split further) and an hour refused alone is moved to `outbox/rejected/` (never retried, discarded after 30 days), then later batches keep pushing. Hours within the last 2 hours of the agent's clock are never quarantined. Candidates confirmed after the canary are quarantined at the end of the run even if a later non-`400`/`413` failure stopped it. Each run mentions quarantined hours on stderr. Any other failure stops the push and keeps the rest. Outbox files older than 7 days are discarded unpushed (the backlog window); `rejected/` files are kept 30 days.
3. Exit non-zero on push failure or any rejected hour so `systemctl status` shows it.

Only hours the VM was running can have data; logs and vnstat history survive reboots, so hours missed because of a stop or push failure are recomputed or re-pushed when the VM comes back.

Log rotation: the trojan container should use json-file rotation (`max-size: 200m`, `max-file: 5`). The installer warns when the container has no rotation; changing the trojan deployment is a separate, manual step.

## Distribution

GitHub Releases of `xuangong/copilot-api-gateway`, tag `telemetry-agent-v<semver>`, built by a GitHub Actions workflow on that tag: `trojan-telemetry.py`, `install.sh`, `SHA256SUMS`.

`install.sh` (run as root, `TELEMETRY_GATEWAY` and `TELEMETRY_KEY` from the environment):
- downloads the same version's files and verifies the agent against `SHA256SUMS` and, when `TELEMETRY_AGENT_SHA256` is set, against that pinned value too, aborting on mismatch;
- installs `vnstat` (apt), the script under `/opt/trojan-telemetry/`, the env file (mode 600), the state directory, and the systemd service and timer;
- runs once immediately and prints the push result;
- warns if the trojan container has no log rotation;
- prints a reminder that the key appears in shell history and can be rotated;
- `--uninstall` disables the timer and removes program and configuration (state optional).

The dashboard's install command pins the agent version and the exact bytes the gateway was built with: it downloads `install.sh` to a temp file, verifies it against the pinned installer SHA-256, and only then runs it with `TELEMETRY_AGENT_SHA256` set. The release workflow checks the built assets against the pinned hashes before publishing.

## Testing

- Gateway (SQLite and D1): push auth and uniform 401; `tlm_` rejected elsewhere and other credentials rejected for push; hour replacement; limits and validation; retention cleanup; owner-only management (admin denied); key shown once and stored hashed; query endpoints (series grouping and top N with `(other)`, top with previous-period change, month-to-date, projection, cost, surge factor/minimum boundaries, freshness).
- Agent (`unittest`, fake `docker logs` and `vnstat` output): hourly bucketing, unit parsing, top-N folding, user mapping, catch-up across a gap, outbox write/delete, stop on failure, 7-day outbox discard and 30-day rejected discard, canary and bisection (systemic refusal costs 2 requests), lock; probe against a local fake TLS trojan server covering success and each failure stage.
- End to end: a test gateway receives a push from the real agent code with fake inputs; query endpoints return the expected numbers.
- Dashboard: panels, stale warning, over-limit projection, settings form, EN/ZH key parity.
- Acceptance: `bun run ci:local` with no failures beyond the known baseline.

## Rollout

1. Merge, push, apply the D1 migration, deploy the Worker.
2. Publish `telemetry-agent-v1.0.0` (owner confirms before the tag is pushed).
3. Create source "trojan-vm" in the dashboard; run the install command on the VM.
4. Add log rotation to the trojan compose file and recreate the container (owner confirms; a few seconds of proxy downtime).
5. Configure budget metric `nic.tx_bytes`, monthly limit, price, user labels, `flagNonZeroMetrics: ["probe.fail"]` and `checkMetrics: ["probe.ok"]`.

## Out of scope

Notifications, sources declaring their own views, sub-hourly data, pulling from sources, editing the trojan deployment from the installer.
