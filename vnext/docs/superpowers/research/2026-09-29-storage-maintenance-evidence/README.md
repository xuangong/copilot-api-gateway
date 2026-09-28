# Local D1 migration compatibility

Captured 2026-09-29 using installed Miniflare 4.20260601.0 and workerd 1.20260601.1. Applied repository migrations 0001 through 0015 to an ephemeral local D1 database with Wrangler's own SQL statement splitter. The new reference guards, indexes and view were present. No production bindings, credentials or data were used.

Copy the `.mjs.txt` to a temporary `.mjs` path and inspect/update its absolute dependency/migration paths before running with Bun. The script applies every migration present, so later runs may include more than the captured 0015 baseline. The initial raw `db.exec` attempt was rejected on the leading SQL comment because that API processes individual lines; using Wrangler's splitter mirrors migration statement handling. This is not a SQL schema workaround.

The captured result proves local runtime migration compatibility only. Runtime cron/R2 behavior and deployed database state were not tested.

## Retained-key query regression

The follow-up query probe runs the exact optimized inactive DELETE after all migrations in local D1. A retained key deletes zero of 30 fresh rows; clearing retention deletes the 25-row batch; hard-deleting the key deletes the remaining five rows. This confirms the SQL expression and retention branches in local D1, not production scheduling or a D1 performance measurement. The script reads the captured exact query from `b07-query-vm-evidence.json`; update its absolute path before rerunning.

A separate Python SQLite 3.53.4 VM-step probe against the complete schema measured the inactive retained-key branch at 17,043 / 170,043 steps for 1,000 / 10,000 history rows before the fix and 51 / 51 steps after it, with zero deletions. Cleared/deleted keys still delete only the 25-row quota. VM steps are local SQLite instruction counts, not production latency. The preserved Python source expects its original scratch layout; the captured JSON embeds both exact query strings and every result.
