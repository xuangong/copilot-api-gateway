# Telemetry v1

External systems push hourly metrics to the gateway with a push-only key. The gateway stores them as a generic time series and shows freshness, month-to-date usage with a projection, hourly charts, top groups, surges, failure flags and point-in-time check results in the dashboard. The first source is a trojan proxy VM, served by the agent in `tools/trojan-telemetry/`. Nothing is sent from the gateway: no email, no chat message. Also set a billing-accurate budget alert in your cloud account (for example an Azure budget alert).

Telemetry is owner-only. Sources, data and settings are visible to and manageable by the owning user only; administrators get no override (`404 source_not_found`, the same as a missing source). It is unrelated to the gateway's internal request-usage recording.

## Data model

A point is `{ metric, hour, dims?, value, unit }`.

| Field | Rule |
| --- | --- |
| `metric` | `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`, 1..64 characters |
| `hour` | ISO 8601 UTC at the top of an hour, `2026-11-16T13:00:00Z` |
| `dims` | optional object of 0..3 entries; keys `^[a-z][a-z0-9_]{0,31}$`, values strings of 1..256 characters |
| `value` | finite number, 0 to 1e15 |
| `unit` | `bytes`, `count` or `ms` |

Tables (migration `0026_telemetry.sql`): `telemetry_sources` (`id` = `tls_` + 32 hex, owner, name, SHA-256 of the key, settings JSON, `created_at`, `last_push_at`) `telemetry_points` (source, metric, hour in unix seconds, canonical dims key, dims JSON, value, unit; primary key source + metric + hour + dims key) and `telemetry_hourly`, a rollup with one row per source + metric + hour holding the unit and the sum over dims (primary key source + metric + hour). Totals, first hours, the metric list, budget and surge reads use the rollup; only grouped series, top, contributors and non-zero flag rows read dimension rows, always by a primary key range on (source, metric, hour). The push key is `tlm_` + 64 hex; only its SHA-256 is stored.

## Push API

`POST /api/telemetry/push` with `Authorization: Bearer tlm_<64 hex>` (scheme case-insensitive) and `{ "version": 1, "points": [...] }`. It is mounted before session auth. A `tlm_` bearer on any other route answers `401 invalid_key`.

- Authentication happens before the body is read. A missing, malformed, unknown or deleted-source key and a disabled owner all answer the same `401 { "error": { "code": "invalid_key" } }`. Any other unexpected failure answers `503 temporarily_unavailable`.
- Any method other than `POST` answers `405 method_not_allowed` with `Allow: POST`, with no credential check.
- The body is at most 2 MiB (`413 body_too_large`, checked on `Content-Length` and while streaming). Everything else below is `400 invalid_request`: not UTF-8 JSON, unknown fields, `version` other than 1, more than 20 000 points, more than 20 distinct metrics, more than 168 distinct hours, a duplicate (metric, hour, dims), a metric used with two units in one body, a value outside 0..1e15 or not finite, an unknown unit, more than 3 dims or a dim key/value outside the rules above, an hour more than one hour in the future, or an hour older than the point's retention (90 days with dims, 400 without).
- Hour replacement: every distinct (metric, hour) pair present in the body is replaced atomically (its existing rows are deleted and the pushed rows inserted, and its rollup row rewritten with the sum of the pushed points, in one batch). Retries and recomputation never double-count and a dimension value that dropped out of a top N does not linger. Only the pairs present are touched: other metrics and other hours are left alone, and an empty `points` array replaces nothing (it only stamps `last_push_at`, a heartbeat).
- `200 { "accepted": <number of points> }`. All responses carry `Cache-Control: no-store`; bodies and headers are not logged.
- D1 statement budget: one push issues at most 20 DELETEs (one per metric), at most 22 point INSERT chunks (a chunk is cut at 1000 rows or 1.5 MB of serialized JSON, whichever comes first), at most 4 rollup chunks (at most 20 metrics x 168 hours = 3 360 rows, 1000 per statement) and 1 UPDATE: at most 47 statements (20 + 22 + 4 + 1) in the batch, plus 2 authentication reads, so at most 49 queries per invocation. Workers Paid allows 1000 queries per invocation (the free plan's 50 would also still fit).

## Management and query API

Requires a real, current `ses_` session (the same guard as sync device management): a `key` query parameter is refused, a mismatched `Origin` is refused on any method and a cookie session must send `Origin` on mutations. Owner-only; administrators are not an exception.

- `GET /api/telemetry/sources` returns `{ sources: [{ id, name, createdAt, lastPushAt, settings }] }`.
- `POST /api/telemetry/sources` with `{ name }` (trimmed, 1..64) returns `201 { source, key, install }`. The request URL must be HTTPS (`400 https_required`, so the install command never names a dead origin; behind a TLS-terminating proxy the original scheme must be preserved). At most 16 sources per owner (`409 source_limit`). Unknown body fields are rejected.
- `PATCH /api/telemetry/sources/{id}` with `{ name?, settings? }` (at least one). `settings` replaces the whole object (strict schema, at most 32 KiB serialized).
- `POST /api/telemetry/sources/{id}/rotate-key` returns `{ key, install }` (HTTPS required); the old key stops working at once.
- `DELETE /api/telemetry/sources/{id}` returns `{ sources }`.
- The key is shown once, in the create and rotate responses; it cannot be read again.
- `install` is the ready-to-run command: one copy-pasteable command (a subshell, so no variable leaks into your shell): `( f="$(mktemp)" && trap 'rm -f "$f"' EXIT && curl -fsSL https://github.com/xuangong/copilot-api-gateway/releases/download/telemetry-agent-v<version>/install.sh -o "$f" && printf '%s  %s\n' '<pinned installer sha256>' "$f" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum -c -; else shasum -a 256 -c -; fi; } && sudo TELEMETRY_GATEWAY='<gateway origin>' TELEMETRY_KEY='<push key>' TELEMETRY_AGENT_SHA256='<pinned agent sha256>' bash "$f" )`. It downloads `install.sh` to a private temporary file, verifies it against the SHA-256 the gateway pins (`TELEMETRY_INSTALLER_SHA256`, the installer as stamped by the release build; `sha256sum -c`, else `shasum -a 256 -c`), and only then runs it as root with `TELEMETRY_AGENT_SHA256` (the pinned hash of `trojan-telemetry.py`) in the environment; the installer refuses an agent that differs. Nothing is piped from the network into a shell and the key is never echoed. The version and both hashes are built into the gateway (`agent-release.ts`; a test recomputes them from the repo, and the release workflow checks the built assets against them), so the command pins the exact bytes the gateway was built with, whatever the release page serves. Values are POSIX single-quoted.
- `GET .../metrics` lists metrics seen in the last 30 days with unit, `firstHour`, `lastHour` and the dim keys seen in the 24 hours before each metric's newest hour.
- `GET .../series?metric=&from=&to=&groupBy=&top=` returns dense hourly `total` and, with `groupBy`, one line per group (`top` 1..20, default 10) plus one `(other)` group for the remainder. Rows lacking the `groupBy` key form the group `""`. For a `checkMetrics` metric it also returns `statuses` and `stages` aligned to `hours`.
- `GET .../top?metric=&from=&to=&groupBy=&limit=` requires `groupBy`; returns the top groups (`limit` 1..100, default 20) with `share`, the previous period (the equal-length window before `from`) and `change` (`null` when the previous value is 0), plus `otherCurrent` and `otherShare`.
- `GET .../summary` returns freshness, the budget block, surges, non-zero flags and the latest check results.

`from` is inclusive and `to` exclusive, both hour-aligned ISO. The default is the last 24 hours through the current hour; the window is at most 90 days.

## Settings

| Setting | Meaning | Default |
| --- | --- | --- |
| `budgetMetric` | metric for month-to-date and projection | none |
| `monthlyLimit` | limit in the metric's raw unit (bytes); the dashboard form takes decimal GB for byte metrics | none |
| `pricePerGB`, `freeGB` | cost conversion for `bytes` metrics, decimal GB (1e9 bytes), price in USD | none |
| `surgeMetrics` | metrics checked for surges (at most 10) | all metrics except `ms` |
| `surgeFactor` | multiple of baseline (greater than 1) | 3 |
| `surgeMinBytes`, `surgeMinCount` | minimum hourly value to flag | 2 GiB, 1000 |
| `flagNonZeroMetrics` | metrics where any non-zero hour is flagged (at most 20), for example `probe.fail` | none |
| `checkMetrics` | point-in-time checks, value > 0 is passed and 0 is failed (at most 20), for example `probe.ok` | none |
| `labels` | display names per dim key and value (at most 8 keys), `{ "user": { "#1": "MacBook" } }` | none |
| `staleAfterHours` | freshness threshold, 1..720 | 2 |

## Analysis rules

- **Month to date** sums the budget metric over all dims from the UTC month start through the current hour. **Projection** = month to date + the average daily total of the last 7 complete UTC days that start at or after the metric's first data hour (a partly covered first day would drag the average down) x the fractional days left in the month. **Cost** = max(0, GB - `freeGB`) x `pricePerGB` in decimal GB and USD, for `bytes` metrics only and only when a price is set (`null` otherwise); reported for month to date and for the projection.
- **Surge**: for each surge metric (summed over dims) and each hour of the last 168 hours, baseline = the average hourly value over the preceding 168 hours (hours without data count as 0). An hour is flagged when `value >= surgeFactor x baseline` and `value >=` the minimum for its unit (`surgeMinBytes` for bytes, `surgeMinCount` for count). An hour is judged only when the metric has at least 24 hours of history before it, so the backfill after a fresh install is not flagged. `ms` metrics are never checked (they are excluded before the cap of 10 metrics, in name order). At most 20 surges are reported, newest first, each with its top 5 dim contributions.
- **Non-zero flags**: every hour of the last 168 in which a `flagNonZeroMetrics` metric is above zero, with its dim breakdown (for `probe.fail`, the failing stage), for at most 50 distinct hours. Zero values are ignored.
- **Point-in-time checks**, per hour: `passed` (value > 0), `failed` (value = 0), `no check` (no point at or after the metric's first point) or `not monitored` (before the metric's first point, or no points at all). `no check` is a warning: the VM may be down or the agent not running. The dashboard shows the hour that is still open and has no check yet as `pending`, not as a warning. A failed hour shows its stage when the matching `<name>.fail` metric is flagged. The summary reports the latest closed hour. No uptime or availability percentage is ever computed: one check per hour says nothing about the rest of the hour.
- **Latency** (`<name>.latency_ms`) is charted only for hours whose `<name>.ok` check passed; every other hour is a gap, because an earlier success in the same hour may have left a stale latency.
- **Freshness**: stale when `now - lastPushAt` is strictly greater than `staleAfterHours`; a source that never pushed is not stale.

## Retention

Scheduled maintenance (`telemetry_retention`) deletes points with dims after 90 days and points without dims after 400 days, expires rollup rows after 400 days, and purges orphans: points and rollup rows whose source is gone. Deleting a source removes only its row; its data stays until the background purge removes it.

The three expiry purges (dimensioned rows, plain rows, rollup rows) run on every sweep: with the partial indexes an empty purge is about one index probe, and a purge that hit its cap continues on the next sweep. Only the orphan loose scan (it walks every distinct source id in both tables) is gated: it runs once an hour, at minute 17 UTC, and again on the next sweep while the previous scan deleted a full chunk or more (tracked in process memory; a fresh Worker isolate falls back to the hourly minute). The Worker cron and the Bun sweep both pass the time through to `sweepMaintenance`. Each class is purged with its own predicate, so each walks its own index: `idx_telemetry_points_hour_dims` (`WHERE dims_key <> ''`), `idx_telemetry_points_hour_plain` (`WHERE dims_key = ''`) and `idx_telemetry_hourly_hour`. A run issues at most 20 DELETE statements (each up to 20 000 rows; at most 5 for dimensioned rows, 3 for plain rows and 2 for rollup rows, the rest for orphans) plus one orphan lookup when the scan is due, so a large purge spans several runs.

## D1 rows read/written

D1 bills rows read and written per query, and each index entry counts as a row. Estimates below assume a source with about 300 points per hour (10 metrics, about 30 dimension rows each; 10 of the 300 points without dims), one push per hour, 90 days of dimensioned rows (2 160 h x 300 = 648 000 rows) and 400 days of rollup rows (10 x 24 x 400 = 96 000 rows). They are order-of-magnitude figures, not measurements; the Workers Paid plan includes 25 billion rows read and 50 million rows written per month.

**Per push** (one hour of 300 points, no earlier rows for that hour):

| Step | Rows written |
| --- | --- |
| 300 point rows (table entry + one partial index entry each) | 600 |
| 10 rollup rows (table entry + hour index entry each) | 20 |
| `last_push_at` update | 1 |
| Total | about 620 written, about 5 read (authentication, existence guards) |

A repeat push of the same hour also deletes the 300 old rows (600 more written, about 300 read). Monthly: 720 pushes x 620 = about 450 000 rows written.

**Per page view** (rows read; one page load = `/metrics` + `/summary` + `/series` + `/top`):

| Read | Before (scan of every retained point) | After |
| --- | --- | --- |
| `/metrics` | metric aggregate 648 000 + dim-key subquery 648 000 + last day 7 200 = about 1 300 000 | rollup loose scan 10 metrics x about 5 seeks = 50, plus the 10 last-hour dimension sets 10 x 30 = 300: about 350 |
| `/summary` | metric list again 1 300 000; first hours about 648 000; surge baselines 10 metrics x 336 h x 30 = 100 800; budget window up to about 38 days (from the earlier of the month start and 7 days ago) = 912 h x 30 = 27 400; flags 2 metrics x 168 h x 30 = 10 100; contributors about 600: about 2 100 000 | metric list without dims 50; first hours 10 seeks; surges 10 x 336 = 3 360 rollup rows; budget 912; flags 10 100 (dimension rows, 168 h window only); contributors about 600: about 15 000 |
| `/series` 24 h, no groupBy | 720 (+ about 65 000 for the check metric's first hour) | 24 (+ 1 seek) |
| `/series` grouped by a dim | 2 x 720 | 24 + 2 x 720 (primary key range, unchanged) |
| `/top` | 3 x 720 | 3 x 720 (unchanged: the total is summed over the same point rows as the groups) |
| Page load | about 3 400 000 | about 20 000 |
| Poll every 5 minutes | about 3 400 000 (it refetched the metric list too) | about 15 000 (summary only), none while the tab is hidden |

An open tab therefore read about 41 million rows per hour before, and about 180 000 now (12 polls x 15 000), and nothing when hidden.

**Per retention run** (steady state; expiry runs every minute and the orphan scan once an hour. Rows are stored per hour and expire by hour, so about 300 dimensioned rows (one hour of data) expire together in a single sweep once an hour, and the other 59 sweeps delete nothing; the daily total is unchanged):

| Step | Before (every minute) | After (every minute; orphan scan hourly) |
| --- | --- | --- |
| Expired dimensioned rows (300 per hour) | 300 read + 600 written, found through an OR predicate that re-walks every plain row older than 90 days: 310 d x 24 h x 10 = 74 400 index rows read on every run | the sweep that crosses the hour boundary reads and writes about 300 rows; the other 59 read about 1 index probe and write nothing |
| Expired plain rows and rollup rows | included in the walk above | the same pattern: about 10 + 10 rows once an hour, nothing in the other sweeps |
| Orphan lookup (5 sources) | about 6 seeks | about 12 seeks (both tables) |
| Per day | 1 440 runs x about 75 000 = about 108 million rows read | 1 440 runs x 3 index probes (about 4 300) + 7 200 expiring dimensioned rows read twice (14 400) + 24 orphan scans x about 12 (300) = about 19 000 rows read, about 15 000 written |

Configuration export and import cover API keys, GitHub accounts and upstreams only; telemetry sources, keys and points are never exported.

## The trojan agent

`tools/trojan-telemetry/trojan-telemetry.py` (Python 3, standard library only) runs as root from a systemd timer. A non-blocking file lock makes a second concurrent run exit 0 at once. Exit codes: 0 success, 1 a collection or push failure or any hour the gateway rejected (so `systemctl status` shows it), 2 a configuration error.

Configuration (`/etc/trojan-telemetry.env`, mode 600, values single-quoted; variables already in the environment win over the file):

| Key | Default |
| --- | --- |
| `TELEMETRY_GATEWAY`, `TELEMETRY_KEY` | required |
| `TROJAN_CONTAINER` | `trojan` |
| `TELEMETRY_IFACE` | `eth0` |
| `TROJAN_USERS` | none (ordered user hashes, comma or space separated, mapped to `#1`, `#2`...) |
| `TROJAN_CONFIG` | auto-detected |
| `TOP_DOMAINS` | 50 (1..1000) |
| `TROJAN_SNI` | `trojan.xianliao.de5.net` |
| `PROBE_HOST` | the SNI host |
| `PROBE_PORT` | 443 |
| `PROBE_TARGET` | `www.gstatic.com:80` |
| `PROBE_TIMEOUT` | 15 seconds (0.5..120) |

`TROJAN_SNI` and the installer's release repository (`xuangong/copilot-api-gateway`) are defaults specific to this deployment's owner; override `TROJAN_SNI` in the env file for another proxy and change the release base in `agent-release.ts` (and `install.sh`) when forking. `PROBE_CA_FILE` (a CA bundle for the probe's TLS check), `TELEMETRY_PREFIX` (a root directory for every installer path, which also skips the root check, apt, systemctl and the first run) and `TELEMETRY_BASE_URL` (the installer's download base, `file://` allowed) are test hooks. Only root can set them in practice (the agent and installer run as root, and the env file is mode 600); do not set them in production, because `PROBE_CA_FILE` weakens the probe's certificate verification and `TELEMETRY_BASE_URL` redirects the download.

`TELEMETRY_STATE_DIR` and `--state-dir` override the state directory. `TELEMETRY_GATEWAY` must be an `https://` URL without query or fragment; plain `http://` is accepted only for `127.0.0.1`, `[::1]` and `localhost`.

State directory `/var/lib/trojan-telemetry/` (mode 700): `cursor.json` (the last fully processed hour), `outbox/<YYYY-MM-DDTHH>.json` (a computed hour, not yet pushed), `outbox/<YYYY-MM-DDTHH>.probe.json` (that hour's probe result), `outbox/rejected/` (hours the gateway refused, see Push) and `lock`. Files are written atomically; the outbox file is written before the cursor moves.

Each run:

1. **Compute** every closed hour in `(cursor, last closed hour]`. A first run backfills 24 hours; a cursor older than 7 days is clamped to 7 days (the outbox backlog window). After downtime the missed hours are therefore caught up (and re-pushed from the outbox) when the logs and vnstat history still hold them. An hour with no traffic still writes an outbox file with no points: it records that the hour was processed so it is not recomputed, and pushing it replaces nothing, so it never clears data the gateway already holds. A docker or vnstat failure stops the loop without advancing the cursor and the run exits 1; a missing vnstat row for one hour is not a failure.
   - Proxy traffic: `docker logs --since <hour> --until <next hour> -- <container>` with absolute UTC bounds (Docker stamps UTC, so the container's and the VM's timezones do not matter). Both stdout and stderr are parsed, streamed line by line (never buffered whole), because trojan-go may log to either. Lines like `user <hash> ... tunneling to <host>:<port> closed sent: <n> <unit> recv: <n> <unit>` (units are 1024-based) are aggregated by user and registrable domain into `proxy.sent_bytes`, `proxy.recv_bytes` (bytes) and `proxy.connections` (count), dims `user` and `domain`. Traffic belongs to the hour in which the connection closed.
   - Per user the top `TOP_DOMAINS` domains by total bytes are kept and the rest folded into `(other)`. If an hour would still exceed one push batch, the top N is halved until it fits.
   - Domains: an empty host is `(unknown)`, a host with non-ASCII characters is `(invalid)` (hosts on the wire are ASCII punycode), values are cut at 256 characters. A user whose hash is not mapped is `#?`.
   - Registrable-domain heuristic (no public suffix list): IP literals are kept; otherwise the last 2 labels, or the last 3 when the TLD is two letters and the second label is a generic second-level label (`com`, `co`, `net`, `org`, `gov`, `edu`, `ac`, `or`, `ne`, `go`, `mil`, `ltd`, `plc`, `nhs`, `sch`, `nom`). Longer public suffixes (for example `foo.pvt.k12.ma.us`) group one level too coarse.
   - NIC totals: `vnstat --json h -i <iface>` is read once per run and yields `nic.tx_bytes` and `nic.rx_bytes` (no dims). JSON v1 counts KiB and v2 bytes. An entry's `timestamp` (epoch seconds) is preferred; without one the entry's local date and hour is converted to UTC. vnstat may lag up to five minutes behind the clock, which the `:05` offset absorbs.
2. **Probe** once, attributed to the hour containing the run, as its own outbox file (a second probe in the same hour replaces the first). The probe is itself trojan traffic: it authenticates with the first configured password, so each probe is counted in the logs under the label the first password's hash maps to (normally user `#1`, unless `TROJAN_USERS` reorders the users) as traffic to `PROBE_TARGET` (a few hundred bytes per hour, which shows up in the per-user and per-domain figures). The probe opens TCP to `PROBE_HOST:PROBE_PORT`, TLS with SNI `TROJAN_SNI` (certificate verified), sends a trojan request with the first configured password to `PROBE_TARGET`, then `GET /generate_204`, and expects `204` within `PROBE_TIMEOUT`. Failure stages: `tcp`, `tls`, `tunnel` (the connection broke or closed without an answer), `http` (an answer other than 204) and `timeout`. Success writes `probe.ok` = 1, `probe.fail` = 0 (no dims) and `probe.latency_ms`; failure writes `probe.ok` = 0 and `probe.fail` = 1 with dim `stage`. The `probe.fail` = 0 on success replaces an earlier failure from the same hour (replacement is per metric and hour); the gateway ignores zero flags. A wrong password reports stage `http`, because trojan-go falls back to its web server for unauthenticated traffic. The password never leaves the VM (only its SHA-224 is sent to the proxy, as the trojan protocol requires). With no readable password the probe is skipped with a warning. A failed probe is data, not a failed run.
3. **Push** the outbox oldest first. An hour's hourly and probe files travel together. Batches hold at most 24 hours, 10 000 points and 1.5 MiB (an hour is never split). The push counts as success only when the gateway answers `200` and its `accepted` equals the number of points sent; the batch's files are then deleted. A network error, `401`, `404`, a `5xx`, a redirect or an `accepted` mismatch stops the push, keeps every remaining file and makes the run exit 1. Redirects are not followed, so the key is never replayed elsewhere. When a batch (of any size) gets `400` or `413` the agent sends a canary: the newest hour that has a computed hourly file alone (the newest hour when none has one; the open hour usually holds only probe points, which would not detect a refusal of hourly data), at most once per run (if that hour is the refused batch itself no extra request is needed). Systemic refusal: when the canary is refused too, the gateway refuses everything (a wrong scope, limits, an incompatible gateway, or a VM clock wrong by more than about 1 h); the run stops, nothing is quarantined, every file is kept, a warning says so and the run exits 1. Such a run costs at most 2 requests, however large the backlog. Bisection: when the canary is accepted the gateway is healthy, so the refused batch is split in halves; each half is pushed (accepted halves are deleted), refused halves are split further, and an hour still refused on its own is moved (atomic rename) to `outbox/rejected/` with a warning on stderr naming the hour and status; later batches keep pushing. Candidates confirmed this way are quarantined after the batches are tried, even if a later non-`400`/`413` failure stopped the run, because the canary proved the gateway healthy. Clock skew: hours within the last 2 hours of the agent's clock are never quarantined, they are kept for the next run with a warning. The gateway rejects points more than 1 h in the future, so a VM clock more than about 1 h ahead makes the recent hours refused (they are kept, and a lone refusing newest hour looks systemic); fix NTP on the VM. If the move itself fails (for example `outbox/rejected` is a regular file, or the filesystem is read-only or full) the agent warns `could not quarantine <hour>: <error>; keeping the remaining files` and keeps the files. Every run also prints one stderr line `N hour(s) in outbox/rejected/ (oldest <hour>); see docs` while the directory has files (this alone does not change the exit code). Quarantined files are never retried automatically (inspect them, fix the cause and move them back into `outbox/` if you want another attempt) and are discarded after 30 days. The run exits 1 when any hour was rejected or a push failed. Files in the outbox older than 7 days are discarded unpushed (the backlog window, `OUTBOX_MAX_AGE_DAYS`), so an outage longer than 7 days loses the oldest hours.

User mapping: `TROJAN_USERS` wins; otherwise the SHA-224 hex of each `password` entry of the trojan-go JSON config, in file order. The config is `TROJAN_CONFIG`, else a bind mount of the container (found with `docker inspect`) holding a `config.json`, else `/etc/trojan-go/config.json`, then `/etc/trojan/config.json`.

## Installer

Create a source on the dashboard's Telemetry page (over HTTPS) and run the command it shows, once, on the VM:

```bash
( f="$(mktemp)" && trap 'rm -f "$f"' EXIT && curl -fsSL https://github.com/xuangong/copilot-api-gateway/releases/download/telemetry-agent-v<version>/install.sh -o "$f" && printf '%s  %s\n' '<pinned installer sha256>' "$f" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum -c -; else shasum -a 256 -c -; fi; } && sudo TELEMETRY_GATEWAY='https://<gateway>' TELEMETRY_KEY='<push key>' TELEMETRY_AGENT_SHA256='<pinned agent sha256>' bash "$f" )
```

The dashboard fills in the version and both pinned hashes; the installer itself is verified before it runs.

Prerequisites: root (for example via `sudo`), a systemd host, `python3`, `curl`, and `apt-get` when `vnstat` is missing (the installer installs and enables `vnstat`; without apt, install it first).

What it does:

1. Downloads `trojan-telemetry.py` and `SHA256SUMS` from the same release version (HTTPS only, also across redirects) and verifies the agent against `SHA256SUMS` and, when `TELEMETRY_AGENT_SHA256` is set (the dashboard command sets it), against that pinned value as well. Either mismatch aborts before anything is installed. The installer never stores `TELEMETRY_AGENT_SHA256`.
2. Installs the agent to `/opt/trojan-telemetry/`, writes `/etc/trojan-telemetry.env` (mode 600) and the state directory (mode 700), and writes the systemd units.
3. `trojan-telemetry.timer` runs `OnCalendar=*-*-* *:05:00` with `Persistent=true` (a run missed while the VM was off happens at boot). `trojan-telemetry.service` is `Type=oneshot` with `NoNewPrivileges=yes`, `PrivateTmp=yes` and `TimeoutStartSec=50min`.
4. Enables the timer, runs the agent once and prints the result; a failed first run is a warning and the installer exits non-zero.
5. Warns when the trojan container has no log rotation (`json-file` with `max-size`): hours whose logs have rotated away cannot be recomputed after an outage. The installer never changes the trojan deployment. Recommended compose logging config:

   ```yaml
   logging:
     driver: json-file
     options:
       max-size: "200m"
       max-file: "5"
   ```

6. Reminds you that the key is visible in your shell history and the process list. If that matters, rotate it on the dashboard and run the installer again with the new key.

Re-installing is the update and key-rotation path: the agent and units are replaced, `TELEMETRY_GATEWAY` and `TELEMETRY_KEY` come from the command, optional keys (`TROJAN_CONTAINER`, `TELEMETRY_IFACE`, `TROJAN_USERS`, `TOP_DOMAINS`, `TROJAN_CONFIG`, `TROJAN_SNI`, `PROBE_HOST`, `PROBE_PORT`, `PROBE_TARGET`, `PROBE_TIMEOUT`) already in the env file are kept unless passed again, and the state (cursor and outbox) is kept.

Remove it with `curl -fsSL <release>/install.sh | sudo bash -s -- --uninstall` (this form is unpinned: nothing verifies the script. For a verified removal, download `install.sh` to a file, check it against the installer hash in the dashboard's command, and run `sudo bash <file> --uninstall`): this stops and removes the timer, service, agent and env file and keeps the state. Add `--purge` to delete the state too. `vnstat` is left installed.

## Releases

A GitHub Actions workflow (`.github/workflows/telemetry-agent-release.yml`) runs only when a tag `telemetry-agent-v<semver>` is pushed (`contents: write` is granted to the release job only, and every action is pinned to a commit SHA). It requires the tag version to equal `tools/trojan-telemetry/VERSION`, `AGENT_VERSION` in `trojan-telemetry.py` and `TELEMETRY_AGENT_VERSION` in `packages/gateway/src/control-plane/telemetry/agent-release.ts`; runs the Python tests; builds the assets with `build-release.sh`; and verifies that the built agent and installer hash to the constants pinned in `agent-release.ts` (`TELEMETRY_AGENT_SHA256`, `TELEMETRY_INSTALLER_SHA256`); and publishes a GitHub release with `trojan-telemetry.py`, a version-stamped `install.sh` and `SHA256SUMS`.

To cut a release (an owner action; nothing here is done automatically):

1. Bump all three version sources together, update `TELEMETRY_AGENT_SHA256` and `TELEMETRY_INSTALLER_SHA256` and merge. Any change to `trojan-telemetry.py` or `install.sh` needs new pins.
2. Deploy the gateway, because the dashboard's install command pins the version it was built with.
3. Create and push the tag: `git tag telemetry-agent-v<version> <commit> && git push origin telemetry-agent-v<version>`.

## Rollout (owner actions, not performed by the branch)

1. Merge and deploy the gateway, and apply the D1 migration `0026_telemetry.sql`.
2. Publish `telemetry-agent-v1.0.0` (push the tag; see Releases).
3. On the dashboard's Telemetry page create the source (for example "trojan-vm") and run its install command on the VM.
4. Add the log rotation above to the trojan compose file and recreate the container (a few seconds of proxy downtime).
5. Configure the source's settings: `budgetMetric: nic.tx_bytes`, `monthlyLimit` (the cap you want to stay under), `pricePerGB` (and `freeGB`), `labels` for the users (for example `{ "user": { "#1": "MacBook" } }`), `flagNonZeroMetrics: ["probe.fail"]` and `checkMetrics: ["probe.ok"]`.
6. Set an Azure budget alert as well: the gateway sends no notifications and its numbers are not billing-accurate.
