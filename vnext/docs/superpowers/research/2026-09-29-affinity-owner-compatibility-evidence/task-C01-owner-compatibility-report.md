# C01 owner compatibility configuration

Status: implementation in progress. Product base c81370dfbad43577e044d51e2db2e8a5df14a1a2; sole product writer in reference-adoption-verify.

## Proposed normalized configuration shape (before implementation)

Both Custom and Azure gain optional `opaqueCompatibility: Record<string, { version: 1, key: string, scope: "credential" | "owner" }>` in owner configuration. No wildcard/global default. Keys and declaration identifiers are strict nonempty, trimmed, maximum 512 characters; each declaration uses the existing shared strict parser. Explicit `{}` removes all declarations on a config merge update. Missing field preserves current no-widening behavior for new configurations.

Custom map keys are exact raw executed model IDs. Azure map keys are `openai:<resolved URL deployment>` or `anthropic:<exact body model>`; prefixes select the actual dispatch surface and prevent ambiguous public aliases from granting declarations. Catalog projection resolves each supported surface using the same provider resolver; a catalog model spanning surfaces gets a declaration only if every applicable surface resolves to the same declaration. Preparation/capture always attaches the declaration for its actual surface and resolved execution model. Exact-target identity and affinityTargetMatch semantics remain the accepted baseline unless root explicitly requests otherwise.

The field is validated in control-plane create/update/import and again at provider construction (including retained catalog reconstruction). Existing owner/admin authorization and generation fencing remain authoritative. Saved declarations survive unrelated UI updates through the existing config spread/merge.

## Delivered implementation and root decisions

- Root accepted the proposed map shape. Shared `parseOpaqueCompatibilityMap` validates/snapshots every map value with the existing strict declaration parser; lookups require an own property, avoiding inherited-name matches. Constructors validate saved configurations as well as the control-plane parser. Empty maps survive canonicalization as an explicit removal.
- Azure normalization moved verbatim from gateway routes to provider-azure/config.ts, with only declaration validation added; this avoids a second declaration-key parser. Its catalog hook resolves the same provider deployment mapping used in dispatch and omits a declaration on missing/disagreeing surfaces. Custom uses exact raw model ID. Both prepare and ordinary response capture attach immutable declarations on the executed target, while existing authority/configuration generation guards remain intact.
- Create/PATCH, admin import, retained provider construction, public DTOs and exports handle declarations. Import rejects malformed declarations before any replace-mode delete. Existing import behavior for unrelated legacy fields is unchanged. Declaration map keys containing secret-like words remain intact on redacted export, and a nonsecret key equal to the import credential sentinel stays literal instead of being substituted with a live key.
- PATCH retains omitted declarations, including existing dashboard edits. The generic `***` credential placeholder cannot bypass validation for this nonsecret map. No dashboard editor was added; the operator document describes the API path and explicit empty-map removal.
- Root explicitly authorized rejecting `authKind: apiKey` on upstream create/PATCH/delete after both implementation tests and root's actual HTTP probe reproduced the old 201 key-authenticated create. Existing owner/admin scope and read behavior are unchanged. Tests cover ordinary owned keys, assigned keys, and explicit keys taking precedence over owner/admin/assigned-user session cookies. User session ownership and admin PATCH continue to work; an assigned user's session still cannot mutate another owner's upstream. No unrelated auth endpoints changed.
- Root explicitly directed preservation of accepted exact-target identity/affinityTargetMatch semantics. This slice does not add Azure surface to exact identity; surface qualification governs only new declaration lookup. The operator document states that boundary. No new global defaults, credential-derived identity, vendor inference, migration, environment variable, or protocol activation.
- MODEL_CATALOG_REVISION remains the accepted foundation's 7: its trusted declaration reconstruction already runs on every binding rebuild, including retained snapshots. No raw catalog schema or trust semantics changed; configuration updates already advance catalogGeneration.

## Tests first and final validation

All commands ran in `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify`, except typecheck/lint which ran in its `vnext/` subdirectory. All SQLite additions use a real temporary on-disk database (with a second connection for retained catalog verification); no module or database mocks.

New test command:

```sh
bun test vnext/packages/gateway/tests/affinity/owner-compatibility.sqlite.test.ts
```

- Initial RED: 0 pass, 5 fail, `/tmp/c01-owner-red.log` (declarations absent and malformed saved configs accepted).
- Auth RED: 6 pass, 1 fail, `/tmp/c01-owner-auth-red.log` (real sessionAuthMiddleware accepted inference key create with 201).
- Import sentinel RED: 7 pass, 1 fail, `/tmp/c01-owner-export-red.log` (literal declaration key replaced with live value).
- PATCH sentinel RED: 6 pass, 2 fail, `/tmp/c01-owner-sentinel-red.log` (malformed `***` map accepted on PATCH).
- Final focused: **9 pass, 0 fail, 195 assertions**, `/tmp/c01-owner-final-focused.log`.

Coverage includes strict create/update/import rejection, retained Custom and Azure catalog reconstruction, remote malicious metadata ignored, immutable/prototype-safe maps, Azure final surface/deployment selection, declaration in actual prepare/capture, stale config zero-I/O fencing, config-generation advancement, exact > declared > degraded ordering with stable same-rank order, required state unwrapping through active selection/provider fetch, unchanged signed source, mismatched declaration scope/key rejection, cross-upstream credential-scope rejection, wrong owner/key authentication rejection, and CRUD session-only authority.

Final regression command:

```sh
bun test vnext/packages/gateway/tests/affinity \
  vnext/packages/gateway/tests/control-plane-upstreams.test.ts \
  vnext/packages/gateway/tests/upstream-dto-races.sqlite.test.ts \
  vnext/packages/gateway/tests/control-plane-data-transfer.test.ts \
  vnext/packages/gateway/tests/control-plane-codex-import.sqlite.test.ts \
  vnext/packages/provider-custom vnext/packages/provider-azure \
  vnext/packages/provider-llm/src/__tests__/opaque-affinity.test.ts
```

Final package typecheck:

```sh
bun run --filter '@vibe-llm/provider-llm' --filter '@vibe-llm/provider-custom' --filter '@vibe-llm/provider-azure' --filter '@vibe-llm/gateway' typecheck
```

Final lint:

```sh
bunx eslint packages/gateway/src/control-plane/lib/import-export.ts packages/gateway/src/control-plane/upstreams/public-dto.ts packages/gateway/src/control-plane/upstreams/routes.ts packages/gateway/tests/affinity/owner-compatibility.sqlite.test.ts packages/provider-azure/src/config.ts packages/provider-azure/src/index.ts packages/provider-azure/src/provider.ts packages/provider-custom/src/config.ts packages/provider-custom/src/provider.ts packages/provider-llm/src/opaque-affinity.ts
```

`git diff --check` passed. Exact final regression/types/lint results are recorded in the freeze section below.

## Owned files (11)

- vnext/docs/opaque-compatibility.md
- vnext/packages/gateway/src/control-plane/lib/import-export.ts
- vnext/packages/gateway/src/control-plane/upstreams/public-dto.ts
- vnext/packages/gateway/src/control-plane/upstreams/routes.ts
- vnext/packages/gateway/tests/affinity/owner-compatibility.sqlite.test.ts
- vnext/packages/provider-azure/src/config.ts
- vnext/packages/provider-azure/src/index.ts
- vnext/packages/provider-azure/src/provider.ts
- vnext/packages/provider-custom/src/config.ts
- vnext/packages/provider-custom/src/provider.ts
- vnext/packages/provider-llm/src/opaque-affinity.ts

Explicit machine-readable repository-relative manifest: `task-C01-owner-compatibility-owned.json`.

## Remaining acceptance and boundaries

Root reported mutable independent authenticated Bun HTTP/SQLite (8 groups), actual workerd/D1 (5 groups), and Azure provider/loopback HTTP/SQLite (3 groups) all passing. These are root-owned diagnostics, not this agent's frozen runtime acceptance. Root owns frozen reruns, review and full CI.

No product writes outside the authorized verify checkout; no commits, push, deployment, real credentials, production config changes, subagents, stash changes or worktree cleanup. This package only produces explicit owner declarations and closes their API-key mutation bypass. Overall C01 remains partial pending root disposition of both this and the Chat/Gemini slice. Incorrect operator declarations can still cause upstream rejection; there is no claim of tested cross-vendor interoperability.

## Freeze — DONE

Product writes are now frozen on the 11 owned paths above. Final regression: **335 pass, 0 fail, 1,277 assertions, 29 files**, `/tmp/c01-owner-regression-final.log`. Four package typechecks exited 0, `/tmp/c01-owner-final-types.log`. All 10 owned TypeScript files passed ESLint with zero errors/warnings (the resolver prints only its multiple-project performance advisory), `/tmp/c01-owner-final-lint.log`. Final `git diff --check` passed. Root owns final review, complete CI and independent frozen runtime acceptance.
