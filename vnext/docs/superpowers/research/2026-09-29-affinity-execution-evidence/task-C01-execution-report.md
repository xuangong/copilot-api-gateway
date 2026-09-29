# C01 Codex execution preparation and fencing prerequisite

Base: `a79fbb48ff763610f67917d18f1597c6befd8eaa`, clean isolated `reference-adoption-verify`.
Status: **round 1 fix frozen for root re-review; C01 integration remains incomplete and inactive**. This is the independently reviewable Codex preparation/fence package requested by root. No commit, push, deploy, live credentials, subagents, or full CI. No plan/evidence files edited.

## Why this prerequisite is separate

The accepted carrier foundation cannot safely select required state using existing `ProviderResponse.execution`: it arrives after inference, omits account/configuration identity, and Codex did not produce it. Copilot raw/Fast selection also happens inside provider fetch. This package establishes the real Codex preparation and I/O fence contract. It does not activate carrier routing or pretend to implement Custom/Copilot or complete Responses+Messages.

## Concrete interfaces

- `LlmModelProvider.prepareAffinityExecution?(Readonly<ProviderRequest>): Promise<AffinityExecutionTarget | undefined>`: uses only the accepted injected catalog and authoritative credential metadata. No model discovery, OAuth refresh, or inference. Missing accepted model, missing configuration generation, absent legacy credential revision, inactive account, or changed constructor configuration snapshot cannot grant an affinity target. A replaced/deleted row throws the existing typed upstream error. Cancellation is honored.
- `ProviderRequest.beforeInference?(AffinityExecutionTarget): Promise<void>`: caller supplies an idempotent fence against the previously selected target. For an implementing provider this runs before initial credential refresh, before auth recovery, and immediately before every inference dispatch. It may run multiple times and must not count invocations as actual HTTP attempts. It can perform authoritative reads. Cancellation before or during this fence prevents subsequent I/O.
- `ProviderResponse.affinityExecution?`: immutable actual target used by the successful/final call, suitable for egress only after selection has been fenced. Codex also returns per-call `execution.modelKey` using the actual raw model. Public aliases are not substituted.
- Provider-facing `StoredUpstreamRecord.catalogGeneration?` exposes the existing adapter field as an optional nonsecret snapshot; gateway's richer stored type continues to require it. Legacy adapters without the field grant no affinity. No migration required.

## Identity authority and lifecycle

`row_incarnation` is created randomly on insert and protected against mutation by existing SQLite lifecycle triggers. Delete/recreate changes it. `catalog_generation` is maintained by migration 0018: configuration, owner/provider, enabled/proxy changes advance it, and `replaceCredentials` explicitly advances it even when config bytes are unchanged. Ordinary token/quota state writes do not advance it.

Codex `readCodexCredential` reads the authoritative repository and fences row incarnation, owner and provider. It now includes a validated safe nonnegative generation. Account subject is the selected `chatgptAccountId`; imported `credentialRevision` is the existing UUID, never a token hash. Affinity `credentialRevision` is the explicit JSON tuple `[configurationGeneration, importedCredentialRevision]`, giving conservative configuration replacement isolation. Legacy accounts missing imported revision remain unsupported for affinity; no lazy shared/default revision is manufactured.

The constructor captures the accepted configuration generation and clones account config; catalog seeding clones incoming catalog data, and model resolution clones the selected entry before awaiting credential I/O. Preparation refuses a generation newer than that construction snapshot. Dispatch reads authoritative account/configuration again, checks the actual access-token lease revision against that account, and refuses an unprovable target when a fence was supplied. Stable OAuth token rotation without account/revision/configuration replacement remains compatible. Normal and Lite requests keep the same actual raw `model.id`; Lite is the existing wire codec/header, not a guessed public alias or separate synthesized model ID.

## Validation

Command:
`bun test ./vnext/packages/gateway/tests/affinity/codex-execution.sqlite.test.ts ./vnext/packages/provider-codex/src/__tests__/provider.integration.test.ts ./vnext/packages/provider-codex/src/__tests__/responses-lite.test.ts`

Result: **85 pass, 0 fail, 1508 assertions**. New real temporary SQLite tests (7) cover normal/Lite preparation-to-dispatch identity and zero preparation network; missing revision/catalog; config/account/incarnation replacement before dispatch; replacement during 401 recovery; ordinary state rotation versus explicit credential replacement; expired-token known mismatch with zero OAuth/inference; cancellation before/inside the early fence with zero credential I/O. Existing provider integration and Lite fixtures remain green. Native-client carrier validation is owned by root, not rerun here.

Package typechecks: `provider-codex`, `provider-llm`, `gateway`, `upstream-repo` all passed. `git diff --check` passed. No `any`, suppressions, non-null assertions, database mocks or real credential use introduced.

## Remaining integration (not delivered)

No active selector calls prepareAffinityExecution or installs the fence. No API-key affinity codec is initialized by production routing. No input materialization, nested agent_message handling, hub analysis recursion, JSON/SSE stamping, canonical item/terminal/snapshot coordination, or durable authenticated continuation is added here. Custom/Azure/Copilot/Claude/Sdf preparation/fences remain separate work; particularly Copilot Fast selection must reuse the exact variant resolver against an accepted catalog without token refresh. Responses+Messages production slice and Chat/Gemini adapters remain incomplete.

Future callers must never send a recognized carrier unchanged when a provider returns undefined: required state excludes that candidate; optional state needs safe whole-block removal or rejection. Only foreign raw/no-stable-key traffic may retain raw behavior. Caller authorization/pins must be applied before ranking. Root owns integration, independent review, full CI and acceptance.

## Independent review fix round 1

The independent review correctly found that the initial outer refresh fence did not cover `ensureInner` internal invalid-grant or losing-CAS recovery. That earlier package's 85 passing tests did not exercise replacement while an OAuth request was in flight. The focused real-SQLite barrier test first reproduced the bug: target B incurred one OAuth request before the eventual inference rejection.

Fix: `CodexBeforeMint` is an optional typed callback receiving the exact token-manager credential snapshot. `ensureCodexAccessToken`/`refreshCodexAccessTokenForRetry` thread it through every internal recursion. `ensureInner` invokes it at every actual mint boundary and rechecks cancellation before invoking the mint callback. The provider's callback validates both that exact snapshot and an authoritative reread against the selected affinity target. Hook-scoped coalescing prevents an affinity-gated request from joining an ungated operation that could recover into a different credential. Existing no-hook coalescing/recovery behavior and original mint callback argument shape remain unchanged.

New real-SQLite deferred OAuth coverage replaces A via `replaceCredentials` while A OAuth waits at a barrier, then releases either `invalid_grant` or a successful mint whose CAS loses to B. Both paths now reject with matching `target changed`, exactly A=1 OAuth, B=0 OAuth, inference=0. B has no usable access token, so the test exercises the internal remint path rather than merely adopting a sibling token.

Fix validation command:
`bun test ./vnext/packages/gateway/tests/affinity/codex-execution.sqlite.test.ts ./vnext/packages/gateway/tests/codex-credential-effects.sqlite.test.ts ./vnext/packages/provider-codex/src/__tests__/access-token.test.ts ./vnext/packages/provider-codex/src/__tests__/provider.integration.test.ts ./vnext/packages/provider-codex/src/__tests__/responses-lite.test.ts`

Result: **181 pass, 0 fail, 1834 assertions** across five files. Four package typechecks and `git diff --check` passed again. No full CI run by implementer. Production integration remains unactivated as described above.

## Owned files

- `vnext/packages/gateway/tests/affinity/codex-execution.sqlite.test.ts`
- `vnext/packages/provider-codex/src/affinity-execution.ts`
- `vnext/packages/provider-codex/src/credential-effects.ts`
- `vnext/packages/provider-codex/src/fetch.ts`
- `vnext/packages/provider-codex/src/provider.ts`
- `vnext/packages/provider-llm/src/types.ts`
- `vnext/packages/upstream-repo/src/types.ts`
- `vnext/packages/provider-codex/src/access-token.ts`
