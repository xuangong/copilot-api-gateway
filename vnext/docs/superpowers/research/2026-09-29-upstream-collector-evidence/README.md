# D02 collector and storage evidence

This foundation is not yet attached to production provider requests. It adds bounded, request-scoped upstream attempt capture and an optional gzip sidecar under the existing opted-in dump lifecycle. Migration 0016 adds the nullable descriptor and extends file-reference guards and retirement. Legacy null and an attached empty capture remain distinct.

## Independent runtime checks

- `stream-output.json`: Bun 1.3.0, actual ReadableStream/Response. Pending-read cancellation preserves unknown totals and previous attempts; a diagnostic Uint8Array copy fault forwards every source byte; real source failure retains its original reason. The source is archived as `stream-probe.ts.txt`; copy to a `.ts` scratch file and run with `VNEXT_PROBE_ROOT` set to a checkout root.
- `d1-output.txt`: actual local Miniflare D1 applied migrations 0001–0016 and exercised missing/claimed stage rejection, adoption, reference view, immutable update/replace guards and deletion retirement. `d1-probe.mjs.txt` retains exact executed source, including local dependency paths; adjust those two imports to installed Wrangler/Miniflare before replaying elsewhere. This was not a remote D1 deployment.
- The focused nine-file suite passed 93 tests after the stream fixes, including real temporary SQLite/FileProvider late-write and maintenance races. Earlier load-related timeout and temporary type annotation failure were corrected and rerun sequentially; they are not represented as successful first attempts.

## Scope and limitations

Response bytes are the HTTP adapter's fetch-body representation, not socket wire bytes. Request prefixes are prepared bytes, not proof of transmission. URLs, unknown headers and raw errors are omitted; allowlisted metadata is bounded. Metadata budgeting uses a conservative fixed reservation plus safe header JSON bytes, not a claim of exact sidecar JSON size. No-observer production paths allocate no collector because activation is a later slice. SQL and file storage are not atomic; optional-sidecar failures preserve the canonical dump where possible, with retired tombstones for late writes.

Final scoped review passed with F1/F2 addressed. Clean CI passed: 4,295 tests, one existing skip, zero failures; typechecks, purity, lint (36 inherited warnings), dashboard build and Workers dry-run passed. Provider/dial wiring and live-provider behavior remain unverified by this evidence.
