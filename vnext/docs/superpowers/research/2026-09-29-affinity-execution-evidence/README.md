# Codex affinity execution prerequisite

The eight-path product package adds read-only Codex execution target preparation, authority checks before OAuth and each inference attempt, and immutable actual execution identity. The target binds upstream incarnation, configuration generation, imported account revision and actual raw model; normal and Lite share that model identity. No migration, dependency or environment variable was added. Production selectors and carrier egress/storage are not activated by this package.

Independent review found that token-manager recovery could mint a replacement credential before the outer fence; fix round 1 moved the typed snapshot check to every actual mint, including invalid-grant and losing-CAS recovery. Real SQLite barrier tests reproduced the old behavior and verify OAuth A=1, B=0, inference=0 after the fix. Scoped re-review approves the fix. Requests carrying a fence are isolated from unrelated coalesced refreshes; no-hook recovery remains unchanged.

Root frozen complete `bun run ci:local`: 4751 pass, 1 existing skip, 0 fail, 84245 assertions. Type checks, purity, lint (35 inherited warnings), dashboard build and Workers dry-run passed. Initial CI stopped on an explicit-import omission in the root evidence script; the fixed script was included in the final passing run.

Actual Bun + independent loopback HTTP + real SQLite acceptance passes nine cases: normal/Lite exact raw model, config/revision/incarnation replacement, expired-token replacement with zero OAuth, 401 replacement with no retry, and in-flight OAuth replacement with no recursive replacement mint. See runtime-result.json and executable fixture. This is synthetic local provider traffic; no live provider or new workerd provider-execution claim is made.

Pinned first-party Codex 8ff74cc9 client acceptance also passes two actual SSE receive/history/next-turn tests using real authenticated foundation carriers: reasoning and RemoteCompactionV2 values replay byte-exact. See the native-client report and retained fixture. This tests client marker handling, not gateway production activation or Messages client compatibility.

C01 remains partial. Active authorized ranking/materialization, other provider execution identities, nested opaque fields, cross-protocol mapping, canonical JSON/SSE stamping and durable continuation must be delivered before marking the feature complete.

Deferred minor API limitation: passing both a shared explicit coalescingScope and different beforeMint callbacks can coalesce across callbacks. All current production gated callers pass no explicit scope; before combining these optional arguments, bind both to the coalescing key. The final whole-branch review must triage this limitation.
