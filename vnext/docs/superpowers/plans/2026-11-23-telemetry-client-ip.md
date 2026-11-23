# Telemetry client IPs and locations: implementation plan

Spec: `docs/superpowers/specs/2026-11-23-telemetry-client-ip-design.md`. Each task is test-first (failing test, implement, pass) and ends in one commit. The agent stays a single file (the installer downloads only `trojan-telemetry.py`), so the geo readers live inside it.

## Decisions

- **D1 Single file.** Readers, correlation and the geo manager are added to `trojan-telemetry.py`; tests build tiny databases with `tests/geo_fixtures.py` (nothing large is committed, nothing is downloaded in tests: the fetcher is injected).
- **D2 Timestamps.** `docker logs` gets `-t`; trojan-go lines are timed by Docker's UTC prefix (ms precision), falling back to the line's own `time="...Z"` / `[INFO] YYYY/MM/DD hh:mm:ss` read as UTC (second precision, centred at +0.5 s, tolerance 2.5 s). nginx lines carry `ms=`. The hour is whatever `docker logs --since/--until` returned (close time), no re-filtering, so a pair straddling an hour edge stays unmatched.
- **D3 Scan object.** Log parsing feeds a `LogScan` (existing user/domain totals, trojan tunnels, nginx records for routed SNIs, per-site aggregates). `parse_log_text` keeps its result shape; `stream_logs` takes a scan factory.
- **D4 Correlation.** Spec rules; byte difference tie-break is the relative `sent` difference; `(unmatched)` is exempt from top-N folding; `proxy.client_match_rate` is per mille of tunnels, emitted only when the hour had tunnels.
- **D5 Dims.** Folded rows use `(other)` for client, location and domain. Unknown locations are `未知`.
- **D6 Geo.** ip2region (IPv4 only, 4 or 5 field regions, `0`/empty ignored) first for China, DB-IP otherwise; Cloudflare (ASN 13335) wins over everything; IPv6 is DB-IP only. Files in `<state>/geo/`, refresh at 35 days, failed attempts are not retried for 6 h, downloads are size-capped, validated by opening them, then atomically replaced.
- **D7 Multi-source.** `Config.sources` (primary from `TELEMETRY_KEY`, extras from `TELEMETRY_SITES` plus `TELEMETRY_KEY_<SOURCE>`); a source without key is skipped with a warning. The primary keeps `outbox/`, others use `outbox-<source>/`; the cursor is shared. An hour is written to every outbox before the cursor moves; pushes are per source and the exit code is non-zero if any fails.
- **D8 Installer.** Extra keys (`TELEMETRY_SITES`, `TELEMETRY_KEY_*`, `TOP_CLIENTS`, `TOP_CLIENT_DOMAINS`, `GEO_DOWNLOAD`) are written and preserved. `TELEMETRY_SOURCE=<name>` makes the pinned command store its key as `TELEMETRY_KEY_<NAME>` (existing gateway/primary key kept). The gateway's create and rotate endpoints accept an optional `agentSource` that adds it to the command.
- **D9 Version 1.1.0**; pins are re-pinned in every commit that changes the agent or installer so the consistency tests stay green.

## Tasks

1. Version 1.1.0, nginx line parsing, trojan timestamps, `LogScan` (agent, `test_logs.py`).
2. Correlation and match rate (`test_clients.py`).
3. Network truncation, location formatting, `Geo` facade without databases (`test_geo_format.py`).
4. ip2region reader (`test_ip2region.py`, `geo_fixtures.py`).
5. MMDB reader (`test_mmdb.py`).
6. Geo database manager: download, refresh, failure handling (`test_geo_update.py`).
7. Multi-source config, state and pushes (`test_sources.py`).
8. Client and site points, top-N, wiring into `compute_hour`, end-to-end with three sources (`test_runner.py`).
9. Installer extra keys and `TELEMETRY_SOURCE` (`test_release.py`).
10. Gateway install command `agentSource`, pins (`telemetry-sources.test.ts`).
11. Dashboard: "Name this value..." (EN and ZH i18n, tests).
12. Docs (`docs/telemetry-v1.md`), final verification.
