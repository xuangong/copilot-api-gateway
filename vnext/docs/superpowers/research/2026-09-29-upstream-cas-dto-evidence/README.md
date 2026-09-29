# C08 repository concurrency and public DTO evidence

Date: 2026-09-29. Accepted input revision: `d5a5d2cc454990c91316536e0fc0129164555cfb`. This package is the repository/metadata/public DTO foundation, not the complete credential-import feature. Independent review and all root acceptance gates passed.

## Delivered boundary

Migration `0017_upstream_row_incarnation.sql` preserves existing configuration and credentials while assigning immutable random row identities. State writes compare the actual raw state and identity, rebase a pure synchronous updater at most eight times, and distinguish missing, replaced and contended targets. Metadata PATCH writes only its allowed columns and cannot restore an older private state. Copilot authorization uses insertion-if-absent and scoped updates. Explicit administrative full-row replacement retains its existing replacement semantics.

Public list/create/PATCH responses select safe fields explicitly; they omit private state and internal row identity. Safe editing configuration, Copilot account display, proxy chains, flags, ordering, model exclusions and SDF expiry hints remain. Codex and Claude Code dashboard rows now have typed display and metadata-only editing. Credential revisions and asynchronous refresh-effect fencing follow in a separate C08 package.

## Executed acceptance

- Writer: 204 focused tests across 14 files, 694 assertions, no failures. The new temporary-file/two-handle SQLite suites contain 31 cases covering lost updates, raw-state replay, NULL/no-op, same-timestamp delete/recreate, owner/provider fences, bounded contention, migration preservation, concurrent metadata/Copilot updates, six provider DTOs, authorization and secret-safe errors.
- Root: frozen product code passed the actual local workerd/D1Repo probe. [Result](d1-result.json) records migration preservation, state replay, write/no-op ABA rejection, eight-attempt contention, metadata rebase, ownership guards, insertion-if-absent, raw INSERT initialization and immutable identity. The harness forwards real D1 statements and uses a second real repository/SQL write between reads; it does not fabricate database responses.
- Root: actual Bun platform, Gateway, temporary SQLite and Chromium passed both Codex/Claude metadata-edit scenarios. [Result](browser/result.json) includes the exact metadata-only PATCH bodies and private-state/config preservation checks. Both edits persisted across reload; no page errors occurred. [Saved rows](browser/saved.png), [Codex edit](browser/codex-edit.png), [Claude edit](browser/claude-code-edit.png). Root inspected the rendered UI. The fixture's process and ephemeral listener were confirmed absent afterward.
- Initial clean-tree CI found one missing generated schema baseline after 4,394 passing tests. The baseline was regenerated and inspected: only the new column and two triggers changed. A normal migration test run then passed 6/6. Review also required replacing inherited `as any` assertions on touched SDF fixture lines with concrete types.

Final independent spec/quality review: **Approved**, no outstanding Critical/Important findings. Final clean-tree `bun run ci:local`: **4,395 pass / 1 existing skip / 0 fail**, with purity, all workspace typechecks, lint, UI build and Workers dry-run passed. The 36 inherited lint warnings remain. The schema/fixture fixes changed no runtime code exercised by the frozen D1/browser acceptance.

## Reproduction

Use the frozen product file hashes in [product-sha256.json](product-sha256.json). `VNEXT_PROBE_ROOT` names a repository checkout with its existing Bun dependencies installed:

```sh
VNEXT_PROBE_ROOT=/absolute/path/to/checkout node d1-runtime.mjs
C08_SOURCE_ROOT=/absolute/path/to/checkout/vnext ./browser/run.sh acceptance
```

Run the commands from this evidence directory. Build that checkout's dashboard first with `bun run build:ui` from `vnext/`. The browser harness uses the locally installed Playwright module named in `browser/validate.mjs`; adjust that module path on another machine. The shell wrapper binds a fresh loopback port, clears inherited application environment, creates a new synthetic database, and shuts down only its own process. Its retained `browser/runs/` artifacts contain synthetic session credentials and must not be committed. No live user database, configured service, OAuth credential or paid inference is used.

## Limits and rollout implications

Apply migration 0017 before deploying the corresponding code. Local workerd/D1 proves this adapter's SQL and row-match behavior; it is not production multi-region D1 acceptance. Browser fixtures use disabled synthetic OAuth upstreams and test editing, not live renewal or inference. State CAS alone does not reject an old credential effect within the same physical row; the next package adds credential revision and token fences. Full-record administrative import remains an intentional replacement operation.

Lint has 36 inherited warnings. The existing GitHub poll test prints a SocketDial initialization error while testing fallback and still passes; this is retained test noise, tracked for final review. These results do not claim pristine logs. No push, deployment, production migration or live credential operation was performed.
