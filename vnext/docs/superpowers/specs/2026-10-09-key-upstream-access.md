# API Key upstream access and priority

Approved direction: the user explicitly selected the reference contract combining whitelist and order on 2026-10-09.

## Contract

- `upstreamIds: null` (including legacy missing field) inherits the existing visible upstream set and default order.
- A non-null array is an ordered whitelist. `[]` allows no upstreams. Never append unlisted providers or reinterpret an empty resolved selection as inheritance.
- Visibility remains the key owner's upstreams plus global upstreams; a key setting cannot grant access to another owner's upstreams. Store stable upstream IDs, not provider kinds or display names.
- Deleted, disabled, or no-longer-visible IDs are inert. Malformed persisted settings fail closed to an empty selection and surface an invalid-settings flag.
- Model mappings resolve first; the mapped model is then resolved within this scope. Explicit upstream pins and affinity cannot escape the whitelist. Affinity may reorder authorized candidates for native/inherited state; ordinary provenance alone does not bind routing.
- This is selection policy, not a new retry/failover mechanism. Preserve existing response and composite-model resolution semantics.
- Apply policy consistently to inference, count-tokens, model discovery, key previews, and provider-backed helper dispatch. Keep aggregate administrator inspection independent where explicitly authorized.
- Settings use the existing mapping-management permission boundary (admin, key owner, or assigned user). They affect all callers using the same key. Choice lists must be resolved for the key owner, not the dashboard viewer, and expose only safe metadata.
- A Key bearer is an inference credential, not its owner's management identity. Preserve dedicated self-service reads and telemetry, but only authenticated management identities may create credentials or change their policy. Project this boundary at the control-plane entry without removing owner visibility from inference.
- Device authorization requires an account login identity. API Key bearers receive 401 and cannot derive a user session that would escape their whitelist or revocation. Existing account sessions and legacy User Keys keep their device-flow contract.
- PATCH is field-local and atomic. Whitelist changes participate in configuration revision invalidation on both SQLite and D1. The hot path must not add SQL reads or per-key copies of the entire upstream catalog.
- UI uses the model-mapping panel's enable checkbox: off inherits defaults; on customizes the ordered whitelist. First enable loads and selects the visible default list before permitting a save; unloaded choices are not an empty whitelist. Checking a row enables it for this Key, unchecking disables it for this Key, and movement changes priority. Existing custom orders and explicit empty selections survive loading and off/on draft toggles. Keep save/cancel, restore-default, unavailable references, an explicit empty-selection explanation, and separate upstream-global status. Reuse existing dashboard styling and translated copy.
- Add migration 0023; never change an applied migration. Docker/Bun/CFW share the contract.

## Interfaces

Internal: `ApiKey.upstreamIds?: string[] | null`, `upstreamIdsInvalid?: boolean`; `ApiKeyRoutingPolicy.upstreamIds?: readonly string[] | null` (undefined is compatibility inheritance). Invalid stored scope projects as `[]` even when model mappings are invalid.

Control plane: key DTO and PATCH `upstream_ids: string[] | null`, camelCase response alias `upstreamIds`; flags `upstream_ids_invalid`, `can_manage_upstreams`. `GET /:id/upstreams` under the existing API-key router returns `{ upstreams: [{ id, name, provider, enabled }] }` for the key-visible universe, including disabled rows, ordered by default order. Unknown/duplicate/foreign IDs are rejected on save, with no secrets exposed. Existing stale references can be removed or restored to inheritance.

Routing: optional `upstreamIds?: readonly string[] | null` in provider list/resolution/enumeration options and auth projections. Filter/order visible upstreams before provider construction and raw catalog aggregation; request-scoped arrays must not mutate shared snapshots. Empty scopes must suppress token-based virtual fallback as well.

## Acceptance

Real SQLite tests cover old-row default, null/empty/ordered round trips, malformed stored data, atomic patches, configuration revision. Route tests cover owner/assigned/admin and forbidden callers, safe choice scope, invalid IDs and dual-cased DTO. Dispatch tests use two upstreams serving a duplicate model and two keys with reversed lists; omitted upstreams, explicit pins, empty scopes, mappings, disabled/deleted upstreams, affinity, catalog metadata and non-chat routes must obey scope. UI state tests cover inherit/custom/empty and stable draft ordering. Run `bun run ci:local`, independent code review, and an isolated local smoke if useful. No deployment is authorized by this feature approval.

## Operations and rollback

Migration 0023 defaults existing keys to inheritance and is additive. Older gateway binaries do not enforce this new whitelist, so retaining the old image does not make a restricted Key safe to downgrade. Rollback must retain whitelist enforcement or take affected credentials out of service before restoring an old binary. No live database or deployed service is changed by this implementation task.
