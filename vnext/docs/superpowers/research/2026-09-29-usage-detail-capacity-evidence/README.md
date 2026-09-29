# Legacy Usage capacity repair

This slice preserves the complete legacy detail and participants content (with the narrow detail-order exception below) while removing key-count-dependent bind and metadata statement growth. It is separate from the Usage projections/consumer experiment: the legacy API still transfers all detailed rows, and no reduction of decoded payload is claimed.

## Runtime comparison

The original diagnostic uses source `8f39d0d6dacac78c77ecf2704631fbd3cf7fa734`. The candidate is based on `cce086c355521ba99bd6aad3429d85b99ec66910`; the source manifest identifies the exact modified files. The same deterministic fixture SQL stream is freshly seeded for SQLite and actual workerd/D1. Each runtime/profile has admin and assigned-only views for today and 28d, including the 117-day strip when applicable. Metric runs measure all HTTP families together; separate JSON-hash runs preserve array order and sort object keys without including hash CPU in the metric timing.

Original large workerd assigned-only detail failed with too many SQL variables. Those failures cannot be compared using error-body bytes or called fast loads. A new frozen-original-source run supplies a complete-payload content oracle for previously successful cases; original status/bytes are checked before using that oracle. Repaired workerd content matches repaired SQLite for every case, including complete response array order.

## Contracts and limits

Usage-only key scopes use one JSON bind and intersect any selected key. Empty scopes fail closed; duplicates do not multiply rows. Two narrow bulk metadata reads preserve own-first keys, visible assignee ordering, missing/empty names, orphan history and complete rosters. Non-Usage query helpers, accounting, overview and browser behavior are unchanged. The fixed route budgets exclude authentication/configuration work; HTTP totals include them. JSON scope bytes, output size, scan work and memory still depend on cardinality.

Production legacy detail/participants do not currently derive `as_user` view context. This pre-existing gap is preserved for compatibility and tracked separately. A composed real-session/grant/SQLite test verifies the shared branch but does not establish production legacy shared-view routing. Future projection endpoints must use the real view resolver per request.

The synthetic comparison is a single-run diagnostic, not a production latency benchmark or React paint measurement. Native D1 first() lacks complete rows-read metadata: null is unavailable, and a known subtotal must not be reported as complete billed work. No production data, push or deployment is involved.

## Source and dependency provenance

The old-source archive was checked against its Git commit. Fresh Bun 1.3.0 installation encountered EXDEV; a copyfile retry stalled at 71 MB and was stopped. The oracle therefore uses isolated copies of installed dependency trees with all workspace links resolved inside the archive. External lock entries match between old and current source; stale unused aliases and an extra uplot package remain recorded. This is not a successful fresh-install or original-time dependency recreation. Generated dashboard assets were built inside the archive.

## Evidence files and restoration

`files-manifest.json` lists each staged file, its original W-relative path, size, purpose and SHA-256. The `harness/` scripts have a final `.txt` suffix for safe inclusion; remove only that final suffix when restoring, except `workerd-entry.ts.txt`, whose `.txt` is part of its runtime filename. The `runs/` layout is intentionally the same as the scratch runner's expected `runs/` directory: it contains the original 16 configs and 16 results, plus the frozen-original-source oracle's 16 parity configs/results, four fixture manifests and exit-status files. The original oracle has 14 complete cases and two retained high/workerd viewer failures. `provenance/` contains the original narrative, candidate revision-2 source hash manifest, source counts, original archive digest and copied-dependency audit. No databases, `node_modules`, large SQL event files/plans, host logs or production credentials are included. Config auth headers are synthetic `ses_d08_admin/viewer` session IDs.

To restore the harness in a new scratch directory, use the staged files without modifying this evidence copy:

```sh
STAGE=/absolute/path/to/d08-capacity-evidence-stage
SCRATCH="$(mktemp -d)"
for name in fixture.mjs instrumentation.mjs sqlite-host.ts workerd-host.mjs whole-load.ts run-detail-baseline.sh compare-detail-json.py summarize-detail.py config.example.json; do
  cp "$STAGE/harness/$name.txt" "$SCRATCH/$name"
done
cp "$STAGE/harness/workerd-entry.ts.txt" "$SCRATCH/workerd-entry.ts.txt"
cp -R "$STAGE/runs" "$SCRATCH/runs"
chmod +x "$SCRATCH/run-detail-baseline.sh"
```

The saved configs are **historical evidence** with absolute original checkout, loopback origin and output paths; do not execute them unchanged. `run-detail-baseline.sh` reads the retained `runs/{sqlite,workerd}-{realistic,high}-baseline/*.config.json`, checks each fixture hash, and writes new configs with the supplied checkout and newly started host origin/output. Call it with an absolute accepted checkout and `repaired-detail metric-and-parity` for a new repaired run. To rerun the old source, reconstruct commit `8f39d0d6dacac78c77ecf2704631fbd3cf7fa734` in a separate scratch archive, verify its file hashes against Git, install compatible dependencies, build dashboard assets there, and invoke the runner with `D08_ARCHIVE_SOURCE_SHA` set to that commit and `original-detail-json-oracle parity-only`. The archived copy's dependency provenance is documented, but the dependency tree itself is deliberately excluded. See the saved script and provenance records for exact inputs and limitations.

For a read-only check of the staged bytes:

```sh
python3 - "$STAGE" <<'PY'
from hashlib import sha256
from pathlib import Path
import json, sys

stage = Path(sys.argv[1])
manifest = json.loads((stage / "files-manifest.json").read_text())
for entry in manifest["files"]:
    path = stage / entry["path"]
    assert path.stat().st_size == entry["bytes"], path
    assert sha256(path.read_bytes()).hexdigest() == entry["sha256"], path
print(len(manifest["files"]), "staged evidence files match their manifest")
PY
```

The saved frozen-original oracle results can be supplied as `ORACLE_RUN=$SCRATCH/runs/original-detail-json-oracle-tBye8f1C` to `compare-detail-json.py` after a completed repaired run. That comparator reads the restored original baseline results at `$SCRATCH/runs/*-baseline`, checks old-source status/byte reproduction before using its JSON hashes, and writes `json-parity-check.json` into the repaired run. The optional `summarize-detail.py` reads the same baseline layout. Each new run needs fresh synthetic seeding; restored result files are comparison evidence, not reusable databases or live hosts.

## Accepted validation and explicit ordering exception

Full CI passed on the eight-file revision-2 manifest: **5,117 pass, one existing skip, zero failures, 86,063 outer assertions**, plus the isolated workerd child's 2,030 assertions. Purity, types, lint, UI build and Workers dry-run passed; 35 inherited lint warnings remain. Root log: `/tmp/vnext-d08-capacity-fix1-ci.log`. The initial default-timeout failure and the isolated child lifecycle/failure/cleanup fix are retained in the reports.

The repaired run `runs/repaired-detail-qumZYkMT` completed all 16 metric and 16 separate parity cases. All repaired SQLite/workerd endpoint JSON hashes match. Of 35 comparable originally successful endpoint bodies, 32 match exactly; three high SQLite assigned-viewer detail bodies differ only in comparator-equivalent ordering. The original strict comparator correctly reports failure and remains unedited at `json-parity-check.json`; it is not relabeled a strict pass.

The old high scoped query used `idx_usage_hour` with 1,003 binds; the bounded JSON scope chose `idx_usage_identity` and a temporary hour sort. Composed/decomposed Unicode identities (`é` and `é`) compare equal in the existing display comparator, so those query plans reverse their otherwise unspecified tie order. Read-only captures were checked against the frozen original/repaired body hashes. Complete row multisets are identical, every array remains nondecreasing under the original comparator, and only 4/16/20 positions in the 1,464/40,069/167,021-row bodies change. See `provenance/task-D08-capacity-ordering-proof.json` and independent ordering review.

**Explicit ruling:** allow only permutations within unchanged-comparator-equivalent complete detail-row groups; no numeric tolerance or other array/order relaxation. This can exchange first-seen legend/distribution order and palette positions for distinct Unicode-equivalent client/model names. Exact wire-order and pixel parity are therefore not claimed. Forcing a query index or key-count branch would encode a planner-dependent order rather than an API guarantee.

Root separately ran the real adapter and AST-extracted current summary/distribution/chart/strip callbacks plus actual forecast helpers: 130 captured-viewer scenarios and 610,093 numeric fields compared exactly, zero differences. Distribution/chart series are matched by identity (unique labels asserted for these chart fixtures), with display order excluded. UTC and local rebinning, both metrics and relevant Unicode filters are covered. This does not claim admin/user-filter replay, complete local HTTP-range acceptance or a browser render. The scripts and `provenance/root-consumer-reducer-proof.json` record exact source hashes and boundaries.

The same-fixture whole-load results are in `runs/repaired-detail-qumZYkMT/comparison.md`. High 28d admin SQL falls from 2,632 to 17 and assigned SQLite from 4,826 to 22, including auth/metadata. High assigned workerd now succeeds (14/22 SQL for today/28d); its original failure has no successful denominator. Decoded bodies remain 53,060,504 bytes for admin and 43,032,207 for assigned 28d loads. SQLite timing is mixed; no universal speedup is claimed. Projections and UsageTab adoption remain separate, pending work.

To reproduce the ordering investigation, restore `capture-existing-sqlite.ts.txt`, `inspect-ordering.ts.txt`, and `compare-consumer-reducers.ts.txt` without the final suffix. The capture script accepts source checkout, retained fixture SQLite path, output path and an optional detail URL path; use the original and repaired run directories' host state in a fresh replay to locate owned fixture databases. Capture today, 28d and strip bodies to the synthetic `/tmp/d08-capacity-{original,repaired}-{today,28d,strip}.json` paths used by the probes. Adjust the two historical run directory names in `inspect-ordering.ts` for new runs before checking their recorded hashes. Run the consumer script with `TZ=Asia/Shanghai`, the accepted absolute checkout and an absolute proof output. Captured large bodies/databases are intentionally not committed.
