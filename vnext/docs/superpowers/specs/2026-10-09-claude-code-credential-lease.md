# Claude Code credential leases and execution identity

Baseline: vNext `a613afcfe2248708d93c1b139c2667990232d1cd`; local reference `1d7dcd923e260e425120cca0c7a240e93720af27`.

## Problem and scope

Claude Code currently reads credentials by upstream ID, coalesces refreshes without a credential epoch, and writes late refresh/terminal/401/quota results into the current account. It cannot prove which installed credential executed a response. Reference Claude Code has the same effect-fencing gaps. Reuse vNext's Codex snapshot/effect architecture without coupling provider packages.

This package covers the existing Claude provider, credential helpers, shared repository contract, and local acceptance. It does not add a Claude authorization/dashboard workflow or a distributed refresh mutex. Preserve shaped Claude Code requests and the existing OAuth/setup-token distinction.

## Identity and lifetime contracts

1. Add `upstreams.credential_generation` using a new additive migration. Create starts at zero. Every explicit credential replacement or full-row replacement increments it, even with identical credentials. Metadata edits and token/quota state updates preserve it. Full replacement also advances the catalog generation so bundle merge cannot reuse an old catalog.
2. Keep credential and configuration generations distinct. Configuration edits must not discard a valid rotated refresh token. Continuation compatibility may conservatively reject a changed configuration, but token publication fences only the credential epoch and exact effect token.
3. A provider-private immutable credential target carries upstream ID, physical row incarnation, owner, provider, credential generation, configuration generation, account UUID, token kind, and health-state timestamp. An access-token lease additionally carries the exact bearer and its expiry. Secrets remain inside private lease/effect objects; never include them in affinity or logs.
4. Effects match the original row/owner/provider/credential generation plus account, credential kind and exact used access or refresh token. SQL enforces the epoch on the initial read, actual update, no-op validation and every CAS replay. Unversioned repository consumers retain their existing contract.
5. Successful refresh publishes access and refresh tokens together, then rereads the authoritative winner. A discarded local mint must never be used for inference. Recovery cannot cross credential epochs or row incarnations. Coalescing uses the captured credential and execution scope, not upstream ID alone.
6. A late 401 only invalidates the bearer that failed. Reuse a usable sibling token within the same epoch; otherwise refresh once. Close the discarded response before retry. Quota writes use the response's original lease, so an old response cannot throttle a new import.
7. A lone `invalid_grant` is ambiguous while another isolate may be rotating. Recover from a published sibling when possible; otherwise fail the request without permanently terminalizing the unchanged credential. Explicit session termination remains a fenced terminal effect. This prevents a losing request from blocking a not-yet-published winner; it does not promise distributed single-flight or external-token recovery.

## Execution and affinity contracts

`prepareAffinityExecution` uses only an accepted catalog and authoritative credential metadata: no discovery, refresh or inference. The model is the actual `providerData.upstreamModelId`, never the public alias or server echo. Each refresh and inference attempt checks a required `beforeInference` fence. The final response carries the target captured from the exact lease used by its actual dispatch.

The affinity subject is `upstream:<id>`: an installed single-credential slot. Revision combines configuration and credential generations. Normal token rotation preserves both and hence preserves affinity. Reimport changes the credential generation. Missing authoritative generations produce no guessed affinity.

`accountUuid` is an internal matching field, not necessarily an authenticated Anthropic account: inference-only credentials can use a locally derived identity after profile access is denied. Client `metadata.user_id`, email and public model aliases are not identity authorities.

Ordinary successful replies can then use the existing four-protocol origin writer. Natural opaque signatures continue to use v1; ordinary origins use v2. No new carrier format, sticky routing or authorization privilege is added.

## Resource and cancellation constraints

Use the existing cached row on the ordinary fresh-token path. No new SQL query is justified merely to format an affinity target. Authoritative reads belong to refresh, recovery and required-history fencing. Preserve the current bounded configuration-cache visibility model; do not claim immediate cross-instance revocation.

Cancellation must prevent further inference or request-owned retry. One caller's cancellation must not cancel an unrelated coalesced operation. Tests must specify whether an already-started refresh is request-owned or shared, and verify its persistence policy rather than assuming abort can undo remote token rotation.

## Compatibility and release boundaries

Claude credential JSON is unchanged, so older strict state parsers can still read migrated rows. Keep the additive column when rolling back; do not drop migrations. Older binaries do not enforce the new epoch or provide Claude affinity preparation: schema readability alone is not transparent continuation rollback or safe mixed-version credential mutation. A production rollback baseline must include the Claude reader/lease contract, and preserve affinity secrets, snapshots and current token state together. Restoring an old database may restore an already-rotated refresh token and is not a normal binary rollback.

No deployment or production-data access is authorized for this package. Use the existing worktree and retain all pre-existing protected files. Validate SQLite, actual local workerd/D1, focused provider cases and full `ci:local`; report performance separately from correctness.
