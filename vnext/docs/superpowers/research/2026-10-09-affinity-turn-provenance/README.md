# Authenticated turn provenance: requirements and delivery

Reference revision: `1d7dcd923e260e425120cca0c7a240e93720af27`.
Implementation starts at vNext `6b5ff39dea61fffd9645370ed19b964a5fae30a7`.
[Design](../../specs/2026-10-09-affinity-turn-provenance.md) and
[task checklist](../../plans/2026-10-09-affinity-turn-provenance.md) define the contracts.

## Why an ordinary response needs an origin

Native opaque state already has a value to wrap, but many ordinary replies have
no such slot. A later Responses history can contain `program_output` or compaction
state without an opaque value of its own. The gateway needs a preceding,
authenticated execution source to determine which authorized candidates can
continue that state. Recording that source only on opaque replies leaves a hole.

The reference evolved through distinct requirements:

| Source | Requirement | vNext decision |
| --- | --- | --- |
| [#225](https://github.com/Menci/Floway/pull/225) | Carry authenticated upstream/model origin on every turn, including synthetic anchors. | Issue origin metadata for four client protocols when actual execution identity and a stable gateway key exist. |
| [#233](https://github.com/Menci/Floway/pull/233) | Separate affinity from item storage; inherit the latest owned source for blobless Responses state. | Keep markers in canonical history/snapshots; consume them before translation and constrain required continuations. |
| [#279](https://github.com/Menci/Floway/pull/279) | Distinguish missing native value from a wholly synthetic item. | Separate v2 origin metadata from v1 native state; authenticate whole-item removal and validate its empty shape. |
| [a2349daca](https://github.com/Menci/Floway/commit/a2349daca7c6ffec33385bdcd26a21a68eacf219) | Remove routing preference based only on an ordinary origin. | Origin-only history stays first-available; it does not prepare all candidates or install an execution fence. |
| [#513](https://github.com/Menci/Floway/issues/513), [#523](https://github.com/Menci/Floway/pull/523) | Continue real Copilot compaction across compatible model identities. | Use provider-supplied execution and compatibility identities; never derive authority from a public model alias. |

Authentication establishes the recorded source. It does not authenticate visible
text or adjacent blobless state, prevent clients from reordering their history,
or grant access to an otherwise unauthorized upstream. These are provenance and
continuation contracts, not transcript attestation.

## Implemented boundaries

- Natural opaque bytes remain v1, including empty strings and existing companion
  authentication. Unknown or corrupt owned markers fail closed.
- Responses uses one independent reasoning prefix; Messages uses one redacted
  thinking prefix. Chat uses the real assistant choice's `reasoning_opaque`;
  Gemini uses a content-bearing Part's `thoughtSignature`, preserving natural
  signatures. No empty Gemini Part is fabricated: Go GenAI Chat would discard
  the entire turn.
- Only Responses currently consumes origin-only history as routing constraints
  for subsequent blobless `program`, `program_output`, `compaction`, and
  `compaction_summary`. Multiple required targets must all match. A foreign slot
  suppresses inheritance for that item without erasing the prior cursor.
- Candidate preparation strips origin metadata. The persisted canonical history
  retains it. Responses native IDs remain intact; wire indices and sequences are
  projected around the prefix. JSON, SSE, WS and saved completed output use the
  same canonical prefix.
- A terminal-only stream emits its prefix before starting the save barrier.
  Cancellation during those prefix events starts no save. Completed delivery
  still waits for persistence. Cancellation after a save has begun does not undo
  that already owned write.
- Messages now uses the existing native-continuation representation guard before
  translating Responses events or bodies. The guard rejects `program`, `program_output`, `compaction` and
  `compaction_summary` even without opaque fields, plus encrypted
  `context_compaction` and encrypted agent messages. Chat and Gemini share this
  guard; text/tool payloads with similarly named business properties remain valid.

Custom, Azure, Copilot and Codex already supply trusted actual-execution capture.
Claude Code does not yet satisfy that prerequisite and receives no guessed
origin. Four client protocols do not imply every provider is covered.

## Local evidence

All upstreams, keys, owners and prompts in this task's probes are synthetic.
Validation used the current local checkout, including the 52 protected pre-existing
files; those files were neither changed nor included in these commits. This is
not clean-checkout release qualification. Raw logs and frozen bundles are retained under
`.superpowers/sdd/2026-10-09-affinity-turn-provenance/` in the existing worktree.

- [Full CI result](validation.json): exit 0; **6,506 pass, one existing skip, zero failures**, 241,084 assertions across 598 files. Framework purity, all package typechecks, lint (zero errors / 41 warnings), dashboard build and Worker dry-run passed.
- [Final workerd result](workerd-results.json): **24/24 pass**, 52 upstream calls, full app + workerd
  + WebCrypto + local D1. It covers nine registered cross-protocol pairs and
  three native paths, JSON/SSE first reply, client history replay, removal before
  provider I/O, wrong-key/unknown-version rejection without extra inference,
  Responses required-source mismatch, and stored continuation.
- Bundle SHA-256: `09d2a24119e98af09e892b5705869ae3d8dbc672d895f2fbc981a9390c1983d0`.
- [Rollback result](rollback-results.json): new natural v1 decodes under the frozen
  pre-reader and current reader; v2 is rejected by the pre-reader and consumed
  correctly by the dual reader without removing required state.
- [Official SDK acceptance](sdk-acceptance.md) passed for OpenAI 6.33.0 Responses and Chat (ordinary/tool_calls), and Anthropic 0.80.0 Messages. The legacy Chat `function_call` collector drops extension fields despite their presence in raw chunks; this measured limit is retained in [SDK results](sdk-results.json).
- `fixtures-green-01.log`: 86 passing existing route/telemetry/snapshot tests.
  Their explicit authenticated fixture keys now use real migrated SQLite signing
  state; telemetry spies and negative-key behavior remain independent.
- The first full CI run is retained as `ci-local-01.log`: 68 failures prompted
  review of old zero-carrier fixtures, exact output budgets and lifecycle
  assumptions. It is not a successful acceptance run.

Reproduce the local workerd probe using the already installed toolchain:

```sh
VNEXT_PROBE_ROOT="$PWD" \
PROVENANCE_EVIDENCE_DIR="$PWD/.superpowers/sdd/2026-10-09-affinity-turn-provenance/workerd-fresh" \
node vnext/docs/superpowers/research/2026-10-09-affinity-turn-provenance/workerd-roundtrip.mjs
```

Run from the repository/worktree root. The script rejects outbound destinations
other than `synthetic.invalid`, creates its own local storage, and disposes its
Miniflare instance. Use a fresh evidence directory to preserve prior attempts.

## Rollback and resource implications

Reader-only commit **`ba80b869`** is the writer-compatible rollback baseline. It
accepts v1/v2 and enforces inherited requirements while issuing only natural v1.
The frozen older `6b5ff39d` reader rejects v2; a writer-enabled release cannot
transparently roll back to that binary once v2 history or snapshots exist.

There is no schema migration and this task changes no production data. A later
release backup must preserve API-key affinity secrets and Responses snapshots
together. Rotating the raw API key is different from replacing its affinity
secret. Do not silently downgrade an unreadable owned marker to foreign data.

The new writer deliberately adds cryptography and wire/history bytes to ordinary
replies. Origin-only ingress avoids full candidate preparation and companion
serialization; prefix state is bounded per turn, and Gemini keeps one event of
lookahead. These implementation properties are not measured CPU/RSS savings.
The October 8 baseline's resource numbers do not describe this writer. Fresh
matched-functionality measurements remain necessary before a CFW release.

## Remaining prerequisites and known gaps

1. **Claude Code credential lease and execution capture.** Refresh success,
   terminal-error writes and 401 invalidation are not fenced to the credential
   that made the request. Coalescing by upstream ID and force/lazy mode can mix reimported accounts.
   Add a lease covering row incarnation/owner/provider, authoritative generation,
   account UUID, token kind, state timestamp and used token; use compare-and-swap
   writes, clear only the token that received 401, and distinguish sibling
   rotation from account reimport. Every inference/retry must report that lease
   and the dated model. A configuration authority alone is insufficient.
2. **Runtime release and MIME gaps from earlier work.** The prior local workerd
   probe found delayed upstream close after downstream cancellation, and Chat
   SSE requests lack bounded JSON fallback for missing/nonstandard MIME.
   This turn's canonical-generator cancellation tests do not close those gaps.
3. **Messages initial text in `content_block_start`.** The [first workerd probe](workerd-initial-failures.json)
   retained three failures: downstream Responses/Chat/Gemini lose text supplied
   entirely in the start event. Source comparison against the baseline confirms
   this behavior predates this writer. Runs 02/03/04 use empty-start + text-delta
   fixtures; their success does not cover the failing variant. Keep the first
   probe and bundle as the reproduction instead of replacing it.
4. **Legacy blobless `context_compaction`.** It neither inherits origin constraints
   nor gains a cross-protocol representation in this change. Its opaque form
   keeps the existing required-state protection. Do not claim support for the
   payloadless legacy form.
5. **Client metadata retention and resource qualification.** A client that
   discards provenance cannot return it. SDK-specific accumulators and the
   unchanged natural companion contracts need explicit boundaries; no promise of
   arbitrary protocol switching or state reconstruction follows from issuance.

## Local delivery commits

- `ba80b869`: reader-first compatibility and required-state inheritance.
- `b184053c`: four-protocol per-turn issuance and integration fixtures.
- `33701ce7`: explicit rejection of unrepresentable native continuation.

These commits and this evidence package are integrated into local `vNext`. No
production version or data is changed. The complete checkout validation above
includes preserved pre-existing work; packaging a clean release remains a
separate gate together with resource measurements.
