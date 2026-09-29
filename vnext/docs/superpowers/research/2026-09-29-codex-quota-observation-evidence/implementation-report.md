# C09 implementation report

## Workspace and scope
- Product workspace: `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify`.
- Base: `ca4dbf05cb868b27248868e7b1ec86626018ee2d`.
- Reference checkout verified at `1d7dcd923e260e425120cca0c7a240e93720af27`.
- Only the 13 vNext paths in `task-C09-owned.json` were changed. No schema migration, credentials/config changes, live providers, commits, pushes, deployments, subagents, or protected dirty trees.

## Delivered behavior
- `readCodexQuotaObservations(rawState, accountId, now)` allowlists persisted fields and validates finite nonnegative numbers and canonical UTC ISO instants. Invalid buckets do not discard valid neighbors. Missing or wholly invalid data is null, never fabricated zero. Real numeric zero and false remain intact.
- `getCodexQuota` returns observation metadata instead of hiding stale buckets. `freshUntil` is fixed at `fetchedAt + computeCodexQuotaTtlMs(data, new Date(fetchedAt))`, retaining the existing 24-hour floor and valid reset/rate-limit horizons. Reads cannot extend this deadline. At the exact deadline the value is stale. The gate in provider fetch is unchanged.
- `GET /api/upstreams/:id/codex/quota`: session-only; owner/admin via `loadOwned`; provider and configured account identity checked; projection uses the exact authorized row without a second credential lookup. Response `{ quota: Record<string, { data, observedAt: ISO, fetchedAt: Unix ms, freshUntil: Unix ms, freshness: 'fresh'|'stale' }> | null }`. Cache-Control no-store; safe fixed 403/404/409/500 envelopes.
- Exact GET/matching-path Copilot-prewarm exclusion preserves authentication and every other method/path behavior. No token renewal, inference, model lookup or outbound work on quota read.
- Dashboard shows an independent quota panel within each existing Codex upstream status card, with primary/secondary usage, credit balance, observation/receipt/freshness timestamps, reset times, fresh/stale label, explicit unknowns, loading/error/retry states and independent stored-observation reload. Credential refresh remains separate. English and Chinese strings added.
- Panel identity is keyed before render; reader aborts and invalidates late fulfilled/rejected requests after account change, replacement read or unmount. Reload never calls model/editor/credential refresh flows.

## Acceptance selectors
- `[data-testid="codex-quota-panel"][data-upstream-id="..."]`
- `[data-testid="codex-quota-reload"]`
- `[data-testid="codex-quota-status"]` (live status, error has role=alert)
- `[data-testid="codex-quota-bucket"][data-active-limit="..."][data-freshness="fresh|stale"]`
- Panel is in UpstreamRow, not in the import modal.

## Owned test evidence
- Focused tests: **93 pass, 0 fail, 339 assertions**, five files; log `/tmp/c09-tests-final.log`.
- Command from repository root: `bun test ./vnext/packages/provider-codex/src/__tests__/quota-observations.test.ts ./vnext/packages/provider-codex/src/__tests__/quota-parse.test.ts ./vnext/packages/gateway/tests/control-plane-codex-quota.sqlite.test.ts ./vnext/packages/gateway/tests/codex-credential-effects.sqlite.test.ts ./vnext/apps/dashboard/src/tabs/upstreams/codex-quota-read.test.ts`.
- Route tests use the actual application with real temporary Bun SQLite, session owner/admin/foreign/missing/API-key auth, malformed buckets, zero outbound counters with preexisting Copilot accounts, unchanged persistence, no-store and exact path/method negative controls.
- Provider tests prove fixed freshness/expiry boundary, old data retention, known reset extension, malformed dates/numbers, unknown vs zero, safe allowlist. Real SQLite dispatch tests prove future rejection blocks with a stale display bucket, expired rejection dispatches, and 100% utilization without rejection dispatches.
- Reader tests prove old-account completion suppression, abort signaling, late rejection suppression after cancel, safe error state and retry recovery.
- Full workspace `bun run typecheck` passed; `/tmp/c09-typecheck-final.log`. Owned-file ESLint passed with only its generic multiple-tsconfig tool notice; `/tmp/c09-lint.log`.
- `git diff --check` passed.

## Boundaries and handoff
- Root owns full CI, independently repeated frozen workerd/D1 and Chromium/Bun acceptance, review, integration and commit. Root reported successful mutable runtime/browser acceptance; this report does not claim those runs as implementer-owned or frozen evidence.
- Frozen SHA-256 map is `task-C09-frozen-sha256.json` (plain map); ownership manifest is a plain array. No further product edits after this freeze without notifying root.
