# Optional API-key shared session secret

Approved UX: each API key defaults to isolated affinity. Owners/admins can enable
shared sessions, generate a cryptographically random secret, or paste the same
secret on other deployments. Keep the established Key settings layout.

## Contracts

- Shared secrets are 32 random bytes represented as 64 hexadecimal characters.
  HTTP authentication keys remain independent. Possessing a shared secret does
  not grant HTTP access; the destination key's routing and quota policy applies.
- Dedicated owner/admin management routes persist the secret privately. Key DTOs
  expose enabled/configured booleans only. Explicit secret reveal is no-store;
  assignees and API-key callers cannot manage or reveal it.
- Disabling retains the stored secret but stops shared issuance and acceptance.
  Existing local v1/v2 readers remain available and their secrets never change.
  Replacing the shared secret intentionally invalidates its old shared carriers.
- Shared native/origin carriers have distinct wire versions (3/4), domain-separated
  crypto, and no local owner/key/database ID in authenticated binding. Native
  bytes and companions remain authenticated; empty reasoning compatibility remains.
  Unknown/invalid owned markers fail closed. Plain foreign upstream state is intact.
- Current local execution identities and pre-inference fences stay unchanged.
  Shared compatibility is an additional per-secret HMAC identity for proven
  provider account/model scope. It cannot infer compatibility from model names
  alone, public aliases, upstream names, or remote catalog declarations.
- Initial portable native-state support targets Copilot configurations with stored
  GitHub account identity, GitHub host/account type, and exact executed model.
  Unsupported execution identities retain local constraints and fail explicitly
  for required cross-instance state; ordinary origin alone does not pin routing.
- Sharing is client-carried history, not database replication. Server-side response
  IDs/files are not made portable. Pre-feature local carriers do not automatically
  become cross-instance carriers: retain source access; migration is separate.
- Configured keys emit shared carriers only after all intended destinations have
  upgraded. Rollback must retain shared-capable readers; pre-feature binaries
  reject new shared versions. No production deployment/configuration change here.

## Validation

Use real SQLite for migration, private persistence and authorization. Exercise
three independent key/user/upstream IDs sharing one secret, wrong-secret and
feature-off rejection, unchanged local reads, native bytes, provenance, permission
filtering, execution mutation fences, JSON/SSE and UI state/copy/save handling.
Run focused regressions, typecheck and the required complete local CI before
integration. Do not claim live cross-account/provider portability without probes.

## Implementation and operations

Migration `0024_shared_session_secret.sql` adds two private columns and a
configuration-revision trigger. It leaves existing local affinity material intact.
The key list exposes only enabled/configured status. `PUT
/api/keys/:id/shared-session` accepts `{enabled, secret?}`; `GET
/api/keys/:id/shared-session/secret` is an explicit owner/admin reveal. Both are
no-store. API-key authentication and assignees cannot use these management routes.

Shared mode retains local execution IDs inside authenticated metadata. Portable
matching adds an HMAC declaration over a versioned namespace, GitHub host/account
ID, account type, endpoint scope and exact executed model. The local row must
still match its incarnation and configuration generation. Preparation and execution
fences continue to compare local identities exactly. Copilot credential exchange
cannot fall back to an unrelated session when an affinity authority is present.
Only already-authorized routing candidates receive portable matching.

Disabled keys do not read shared secret material or derive shared cryptographic
keys. Enabled keys load the secret once per request and memoize account/model
HMAC work for that request. No synchronization service, shared database, background
polling or remote identity lookup is introduced. This is a cost model, not a
production latency/CPU/memory measurement.

### Enable across deployments

1. Back up each environment's database and record its current image/Worker version.
   Preserve the local affinity fields as well as both new shared-session columns.
   Ordinary configuration exports omit private affinity secrets; they are not a
   substitute for a database backup. Keep backups access-restricted.
2. Apply the additive migration and deploy shared-capable readers to every target,
   keeping the feature disabled initially. Verify ordinary isolated requests.
3. On the source key, edit Shared session secret, enable it, generate a secret and
   copy it. Save. Paste that same secret into the corresponding destination keys,
   enable and save each. HTTP API keys remain different. Use only keys and sites
   whose operators should be trusted to authenticate each other's carried state.
4. Start a new conversation after enabling. Replay its complete history to each
   target with a compatible Copilot account/model. Check local routing permissions,
   error handling and usage before relying on it for long sessions.

An existing conversation may contain old v1/v2 frames even after its next reply
uses v3/v4. Enabling the switch does not convert those old frames. Preserve access
to the original deployment for those conversations; history migration is separate.
Providers other than proven Copilot accounts do not gain automatic native-state
portability in this release. Matching public model names is insufficient.

### Rollback and rotation

- Before enabling shared output, reverting to the previous binary is compatible
  with old isolated histories. Leave additive database columns in place.
- Once shared output has been issued, preserve shared-capable readers to continue
  those histories. Older binaries reject v3/v4; reverting a database alone cannot
  undo state already carried by clients.
- Disabling stops both shared reads and writes but retains the secret. Re-enable
  the same secret to accept those frames again. Disabling is not a transparent
  rollback for active shared histories.
- Replacing the secret invalidates previously shared frames. To undo an accidental
  replacement, restore the previous secret from a protected backup; histories
  issued under the replacement will then stop working. No multi-secret reader or
  automated rotation is provided.
- Key settings are read once per request. An already-started request may finish
  under the setting it loaded; changes govern subsequent requests.

No live deployment or real upstream cross-site probe is included in this change.

## Verification record (2026-10-10)

- Complete `bun run ci:local`: success; 6,710 tests passed, 2 skipped, 0 failed.
  Purity, all workspace typechecks, lint (0 errors, 41 warnings), dashboard build
  and Cloudflare Worker deployment dry-run passed. No deployment was executed.
- Affinity/settings/UI-state focused run: 241 passed. Covers shared/native and
  origin versions, legacy readers, wrong/disabled keys, protocol and companion
  binding, grouped agent-message substitution, JSON/SSE round trips, and settings
  authorization/redaction. An additional migration-upgrade regression verifies
  old key material survives and revision invalidation only follows real changes.
- Three independent in-memory SQLite repositories use different owner/key/upstream
  IDs. Actual Copilot provider execution against a local HTTP fixture replays
  required native bytes across all three and back to the first. Wrong accounts,
  hosts, models, unauthorized candidate sets and changed execution configuration
  do not gain a route. This verifies gateway contracts with a controlled upstream,
  not the live providers' cross-site compatibility.
- Headless Chrome against the actual React panel and real SQLite management routes:
  default off, missing-secret validation, generation, clipboard copy, save,
  redacted key list, reveal/hide, cancel, disable/re-enable preservation, no-store,
  Chinese labels and 390px mobile layout passed. Isolated test processes and
  temporary dependencies were removed after verification.
- The pre-existing collaboration overlay was compared with its starting patch:
  all 10 tracked files were unchanged and excluded from this feature's commit.

Next release gate: back up and upgrade all three environments while disabled,
then explicitly enable corresponding keys and probe a newly issued real session
across sites. Existing isolated histories and live upstream acceptance remain
outside this local verification.
