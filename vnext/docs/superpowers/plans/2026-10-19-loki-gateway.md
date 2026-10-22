# Loki Gateway Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The Windows member owns the independent desktop application and its Windows test plan.

**Goal:** Accept narrowly scoped Windows token updates and route supported model requests to Loki.

**Architecture:** A dedicated provider reads authoritative upstream credential state. Owner-authorized management issues pairing credentials; a separate sync router performs fenced state transitions. The Windows application proactively uploads tokens without receiving gateway management authority.

**Tech Stack:** TypeScript, Bun tests, Hono, existing SQLite/D1 upstream state storage, Cloudflare Workers.

**Spec:** `../specs/2026-10-19-loki-windows-auth-design.md`

## Global Constraints

- Fixed `loki-df-v1` profile; Unix milliseconds on the wire.
- No WAM/OS imports in gateway code, no provider-to-provider dependency.
- Existing owner/admin gates; an inference API key is not a management session.
- Bound request bodies, safe error codes, no token-bearing diagnostics.
- Existing untracked work stays untouched. No production deploy or service restart in local implementation.

### Task 1: Credential state and wire contract

Create `packages/provider-loki/src/state.ts`, `profile.ts`, package manifest and `src/__tests__/state.test.ts`.

Interface: `parseLokiSyncUpdate(unknown): LokiSyncUpdate`, `applyLokiSyncUpdate(state, update, payloadHash, now): LokiState`, `publicLokiStatus(state, now)`.

- [x] Write state-transition tests before implementation: first identity binding, expiry rejection, CAS conflict, repeat identical request, different payload reuse, account mismatch and status-only token preservation.
- [x] Run `bun test packages/provider-loki/src/__tests__/state.test.ts` and confirm missing behavior fails.
- [x] Implement strict parsing, immutable transitions and safe status projection.
- [x] Run the same tests and package typecheck.

Key assertions:
```ts
expect(() => applyLokiSyncUpdate(state, staleUpdate, "hash", now)).toThrow("revision_conflict")
expect(publicLokiStatus(state, now)).not.toHaveProperty("accessToken")
```

### Task 2: Management and sync routes

Create `packages/gateway/src/control-plane/loki/routes.ts` and `sync.ts`; mount management after session authorization and scoped sync before generic credential authentication. Create `packages/gateway/tests/control-plane-loki.sqlite.test.ts`.

- [x] Test with a real temporary SQLite repo: owner/non-owner/API-key access, wrong secret, revoked generation, expiry, same-request retry and concurrent uploads.
- [x] Confirm requests fail before route implementation.
- [x] Reuse `loadOwned` and fenced `saveState`; hash random sync secrets, return pairing only on creation/re-pair, invalidate previous authority atomically.
- [x] Test that ordinary public DTOs and diagnostics cannot contain token or secret.
- [x] Freeze pairing/status schemas with the Windows member using a versioned Resource.

Required response checks:
```ts
expect(foreignOwner.status).toBe(404)
expect(inferenceKey.status).toBe(401)
expect(conflictingUpload.status).toBe(409)
expect(JSON.stringify(publicDto)).not.toContain(testAccessToken)
```

### Task 3: Provider and routing registration

Create `packages/provider-loki/src/provider.ts`, `plugin.ts`, `models.ts` and provider tests. Extend `UpstreamKind`, gateway provider registry, provider manifests and Docker package-copy list.

- [x] Add fixture tests for explicit supported endpoints, fixed Loki headers and credential expiry/replacement before dispatch.
- [x] Implement authoritative credential reads and streaming egress using existing provider-llm transport contracts.
- [x] Preserve per-request cancellation and translate through existing protocol infrastructure.
- [x] Test model-to-binding conversion without model-name capability guessing.
- [x] Run focused provider/routing regression tests and workspace typecheck.

### Task 4: Pairing UI and integration

Locate existing upstream form/list and credential action components in `apps/dashboard/src`; add Loki creation/pairing/revocation/status using their current patterns, with pairing parsing/state logic in testable modules.

- [x] Test pairing-state parsing and redaction before adding UI logic.
- [x] Add explicit copy/import pairing workflow and non-secret renewal status.
- [x] Build dashboard and test native-protocol fixture requests.
- [ ] Inspect the dashboard in a real browser. Local browser hosts failed to launch; no visual acceptance claim.
- [x] Run `bun run ci:local`; distinguish baseline issues from new failures.
- [ ] Achieve a fully green `ci:local`: six PowerShell module-loading failures also reproduce on the unchanged base checkout.
- [x] Record local tests, Windows evidence and Worker dry-run separately. Real WAM and actual CFW egress require their own evidence; do not infer them from mocks or dry-run.

## Review follow-up

- [x] Require an actual session record and same-origin cookie mutations, excluding legacy user keys.
- [x] Strip Loki sync/token authority from configuration backups and reset authority on import.
- [x] Reject generic Loki owner transfer so old pairing authority cannot cross owners. Independent review reproduced the failure before the fix.
- [x] Full-app scoped-secret isolation, disabled-owner refusal and all three native inference routes tested with real SQLite and synthetic egress.
- [ ] Real Windows WAM sign-in, HTTP cross-host pairing, reboot/logon and CFW egress acceptance.
