# Task 6 upstream-kind hydration slice

Status: complete; ready for independent root review. Frozen 2026-10-01.

## Problem and change

`FileDumpStore` hydrates dump upstream references from the current `upstreams` SQL join. Its known-kind Set listed only copilot/custom/azure/sdf, so valid codex and claude-code rows silently returned as custom in both list and detail reads.

The known-kind table now uses `Readonly<Record<UpstreamKind, true>>`, making future union additions a compile-time omission error. It covers all six current kinds. Hydration uses `Object.hasOwn`, preserving the unknown-provider fallback and preventing prototype names from being accepted as supported kinds. No migration or stored data rewrite is needed.

## Owned files

- `vnext/packages/gateway/src/repo/dump-store.ts`: only the known-kind table, its own-key hydration guard, and the now-stale introductory kind comment changed.
- `vnext/packages/gateway/tests/dump-upstream-kind.sqlite.test.ts`: new real file-backed SQLite and FsFileProvider roundtrip coverage. It uses actual migrations, `FileDumpStore.put`, `get`, and `list`; both request and response bodies traverse real gzip files. All six known kinds are tested along with unknown-provider, __proto__, constructor, toString and hasOwnProperty. Capture-time upstream name/kind deliberately differ, proving reads use the SQL hydration boundary.

## Verification

- Before implementation: **9 pass / 2 fail**, with only codex and claude-code failing as custom (`task-6-kind-red.log`).
- New roundtrips plus existing dump store suite: **31 pass / 0 fail / 102 assertions**, two files (`task-6-kind-green.log`).
- Gateway scoped typecheck: exit 0 (`task-6-kind-typecheck.log`). This also confirms the previously reported concurrent Task 6 typecheck blocker is now cleared in the shared worktree.
- Scoped ESLint for both owned files: exit 0, no lint findings (`task-6-kind-lint.log`).
- The frozen Task 4 source/test hash manifest remains unchanged. No Task 4 files, other Task 6 source, Git state, service state or deployment were modified by this slice.

File manifest: `task-6-kind-files.json`; frozen hashes: `task-6-kind-hashes.json`.
