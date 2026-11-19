# Reference gap adoption (2026-11-19)

Tracking index for adopting copilot-gateway changes made after the last
adoption baseline (`1d7dcd923`, 2026-09-27) up to `ab7d27239` (#751,
2026-11-19), and for the test/architecture restructuring that goes with it.
Earlier adoption: [2026-09-29 follow-up](2026-09-29-reference-adoption-follow-up.md).

## How each item is judged

The reference's code shape is not the spec; its reason is. Every item below
records **why** the reference changed (commit message, PR, test names), the
**current** vNext behavior, and an **acceptance** check written as observable
input → output, usually mirroring the reference test. An item is done when a
test encoding that acceptance fails on the old code and passes on the new.

Principles taken from the reference's `AGENTS.md` and test history, applied
to every fix here:

- **Fix the class, not the instance.** Make the defect structurally unable to
  recur (shared helper + a guard test), not only the reported input.
- **Upstream-owned values stay upstream-owned.** Capability comes from
  metadata/config; open-string protocol values are forwarded verbatim; vendor
  knowledge lives in the owning provider package, with a source link on every
  vendor constant.
- **Tests must be able to fail for a reason worth knowing** (#695): no
  restating constants, no fully subsumed duplicates; repeated cases become one
  table.
- **Policy changes are not bug fixes.** Items that change a default for all
  users are listed under *Deferred — needs a decision* instead of adopted.

Status: `[x]` done (commit), `[ ]` adopt, `[-]` deferred with reason.

## Done

- [x] GHE.com tenant login through device flow (`b5589f00`). Why: the
  paste-token path depended on extracting VS Code's token; GHE.com accepts the
  same public client id. Accept: start/poll with `github_host` hit
  `https://<host>/login/...`, `api.<host>`, and store `endpoints.api`.
- [x] GHE.com quota/identity on the tenant (`bb3cfc0d`). Found by the
  architecture audit, not the reference. Accept: quota and token check for an
  `acme.ghe.com` account call `api.acme.ghe.com`; guard test
  `tests/architecture/github-host-boundary.test.ts` forbids hardcoded
  github.com origins.
- [x] #714 redeclared Responses tools (`73ee951e`). Why: Codex redeclares tools
  in `additional_tools` and after compaction; 89 tools / 70 names → Anthropic
  400. Accept: `exec` declared as first/second/latest reaches Messages and Chat
  once, as `latest`, in the first slot.

## Translation (packages/translate, result)

- [x] (d38d6f2a) #620 Gemini stream errors. Why: Google JS/Go SDKs only recognize a
  mid-stream error written as bare JSON. Current: `data: {"error":{message}}`
  and code/status dropped (`gateway/.../gemini/respond.ts:158`). Accept: the
  stream's last chunk parses as `{error:{code,message,status}}` with no
  `data:` prefix.
- [x] (60edc827) #619 silently dropped input. Why: dropping input yields confident wrong
  answers. Accept: Gemini `inlineData` PDF → Chat `file` / Responses
  `input_file`; audio → `input_audio` (mp3 for audio/mp3 and audio/mpeg);
  other MIME throws; Messages `tool_choice` naming an undeclared tool throws;
  empty `reasoning_effort` passes through unchanged.
- [x] (1ed9ec23) #743 Anthropic tool input without deltas (Responses path). Accept:
  `tool_use input:{}` with no deltas → `arguments: "{}"`, not `""`.
- [x] (8f0c8694) #702 empty repeated tool-call name (Gemini via Chat). Accept: fragments
  `{name:"bash"}, {name:"",…}` keep `functionCall.name: "bash"`.
- [x] (ca4732f8) #703 Gemini thinking levels. Why: the wire enum is uppercase. Accept:
  LOW/MEDIUM/HIGH/MINIMAL → low/medium/high/minimal,
  THINKING_LEVEL_UNSPECIFIED → unset, on Chat, Responses and Messages targets.
- [x] (394d4da1) #717 empty reasoning. Why: empty thinking blocks are rejected by
  Anthropic. Accept: no thinking block unless text is non-empty or a signature
  exists; an empty first block does not shadow a later non-empty one.
- [x] (441877ef) #712 upstream error details. Accept: a Responses `error` event keeps its
  message and code through JSON reassembly and Messages translation (type not
  collapsed to `api_error`); the following `response.failed` is consumed.
- [x] (1e82f345) #735 unframed SSE payload. Why: some upstreams end a stream with a bare
  (possibly multi-line) JSON error, which looked like a clean end. Accept:
  `data: {...}\n\n{"error":{"code":503}}\n\n` parses as two frames, the second
  marked raw; CRLF and multi-line handled.
- [x] (df35125d) #739 standalone function_call_output. Why: Codex `/goal` context arrives
  as outputs without `call_id`; strict upstreams reject the request. Accept:
  `{type:"function_call_output", name:"goal", output}` without call_id becomes
  a user message `<external_goal>…</external_goal>`; missing name → 400.
- [x] (b9d5b457) #557 payload isolation. Why: a translated request sharing objects with
  its source corrupted compact replay / repeated dispatch. Accept: no object
  in a translated target is reachable from its source or a previous target
  (nine pairs).
- [x] (f62a1517) #548 bounded namespace name allocation. Accept: allocation work linear in
  tools; names unique and ≤ 64 chars.
- [x] (9aff5e4f) #658 sparse/interleaved Messages streams in the web-search shim. Why:
  vLLM-style streams omit usage; translated streams overlap blocks. Accept:
  overlapping blocks pass through the shim unchanged; missing usage tolerated.
- [-] #582 serialize overlapping content blocks for specific SDK user agents —
  feature flag keyed on client UA; revisit after #658.
- [-] #724 only `max_completion_tokens` on Chat targets — changes the wire for
  every custom Chat upstream; Copilot already handled. Needs a decision.
- [-] #711 multiple choices — reference intent for single-choice clients unclear.
- [-] #594/#599/#673 shared stream/input IR — architectural rewrite of the
  pairwise translators; see Architecture.

## Gateway data plane

- [x] (62e8c17c) #558 hosted tools declared in `additional_tools` / `tool_search_output`.
  Accept: a nested `{type:"web_search"}` is rewritten in place and dispatched
  locally.
- [x] (683d04d2) #549 hosted-tool alias collisions. Accept: `allowed_tools` selecting
  `web_search` is rewritten to the alias; a history `function_call` named
  `web_search` makes the helper `web_search_2` instead of a 400.
- [x] (cb807604) #631 thinking signature round trip. Accept: `signature: ""` returns as
  `""` (typeof check, not truthiness).
- [x] (479d35b9) #659 empty model list. Why: no reachable upstream is a normal state.
  Accept: `/v1/models` and `/models` with no upstreams → 200 empty list.
- [x] (6838b54e) #713 Gemini under `/v1`. Accept: `/v1/models/x:generateContent` behaves
  like `/v1beta`.
- [x] (9c8c9939) #617 `x-reasoning-included: true`. Why: Codex otherwise re-estimates old
  encrypted reasoning and compacts too early. Accept: successful JSON/SSE/WS
  Responses carry the header; failures do not.
- [x] (279b2a9b, 88e09031) #616 compaction shares the prompt cache. Accept: summarizer prompt is a
  final user message after the history; a tool-only reply retries once with the
  system-prompt variant; usage summed.
- [x] (db990102) #614 downgrade only disallowed inline system turns. Accept: a system turn
  after an assistant turn becomes `user`; one between user and assistant is
  kept; directive-only turns kept.
- [x] (48fe7e48) #661 Chat encrypted `reasoning_details` through affinity. Accept: on a
  different upstream only that entry is removed and the request is marked
  degraded; on the same upstream it returns unchanged.
- [x] (c2e5950e) #671 web-search page matching. Accept: exact URL, then canonical without
  fragment / trailing slash, then a single leftover pair.
- [x] (71fda1c3) #657 Codex alpha-search fields. Accept: `response_length`, `domains`
  intersection, `recency` → time range; `null` = absent.
- [x] (1df3ff2d) #633 hosted-tool replay grouping. Accept: parallel calls replay as
  `fc_a, fc_b, fco_a, fco_b` with the upstream's raw argument string.
- [-] #572 compact shim on by default for every provider — policy.
- [-] #601 gateway-wide stateless Responses flag / Codex `store` default — policy.
- [-] #663 per-key upstream order randomization — new feature.
- [-] #741 cross-upstream failover — vNext picks one upstream per request; a
  failover design is a separate decision.

## Providers

- [x] (3248af6b) Codex #559 keep `context_window` and `max_context_window` separate.
- [x] (88a9b95e) Codex #567 client version `0.159.3` (models hidden/rejected otherwise).
- [x] (4f71df3c, 60892d6c) Codex #570 quota expiry from exhausted windows only (a 429 at 100%/300s
  with a 40%/7d window must block for 300s, not 7 days).
- [x] (7b591b90) Codex #577 Ultra → last non-ultra effort via `multi_agent_reasoning_effort`.
- [x] (fcd79388) Codex #740 audio modality must not throw the catalog; keep unknown
  modalities; Fast only when advertised. Partial: `input_audio` request
  passthrough not ported; Fast is never advertised for Codex rows today, so
  advertising it from ChatGPT `service_tiers` would be a new feature.
- [x] (e82c69dc) Codex #543 Responses Lite keeps caller `additional_tools` positional and
  does not inject default instructions. Partial: default instructions no
  longer injected for Lite; the encoder still hoists caller `additional_tools`
  to the front on purpose (compact restore and identity repair depend on it) —
  see Decisions.
- [x] (a4a054c2) Claude Code #716 per-model quota rejection must not block sibling models.
- [x] (6cf68e4a) Claude Code #571 `max_tokens` fallback 32768 (version pin stays
  deliberate).
- [x] (32a30d66) Claude Code #715 pricing rows for sonnet-5-5, haiku-5-5, fable-5-1.
- [x] (30eee462) HTTP #638 decode `br` and `zstd` (and stacked codings) on socket responses.
- [x] (e7be68a8, 60892d6c) Custom #729 credential header per request protocol (Messages →
  `x-api-key`, OpenAI → Bearer).
- [-] #602 scheduled subscription usage refresh — feature.
- [-] #691 native TLS for inner proxy legs — performance, platform research.
- [-] #723 Kimi Code, #734 Gemini as native upstream — new providers.

## Architecture and tests

From the 2026-11-19 audit (731 test files; three test-folder conventions;
`buildApp` redefined in 48 files, stream readers in 49, raw
`globalThis.fetch =` in 89; Copilot logic split across gateway and
provider-copilot; ~27 gateway files branch on provider kind).

- [-] Exclude `docs/**` research harnesses from `bun test` — not needed: they
  pass here since `fd7fa8bf`, CI prepares their reference snapshot on purpose,
  and Bun 1.3.0 has no ignore option. They are their own `research` tier.
- [x] Selectable test tiers (`scripts/test-tiers/`): `test:fast` (685 files,
  ~78 s), `test:slow` (`.proc`/`.d1`/`.workerd`, 14 files, ~19 s),
  `test:research`. Six process-spawning tests renamed `.proc.test.ts`; a guard
  test fails when a spawning test is not named for its tier.
- [x] `test:isolation` runs each fast file in its own process (~23 s, in CI and
  `ci:local`). It found three files that passed only because earlier files left
  the platform initialized (`compact-window`, `attempt`, `stream-failure-wire`);
  each now calls `setupTestPlatform()`.
- [x] (c2b8bd96) Shared `@vibe-core/test-utils` (`jsonResponse`, `sseResponse`,
  `collect`, `readBodyText`, `recordingFetcher`, `withMockedFetch`,
  per-file `createFetchStub`). Migrated gateway's `_stub-global-fetch.ts` and
  the 18 exact-duplicate helper definitions; the audit's larger counts were
  name/shape variants, left for incremental migration when files are touched.
- [x] Real repo instead of hand-written fakes: `copilot-quota` and
  `github-accounts` tests now store rows in `setupTestPlatform()`'s SQLite
  repo (−100 lines; chain tests still fail under the bypass mutation). A
  ratchet test (`repo-fakes-ratchet`, MAX 77) stops new `as unknown as Repo`
  fakes; the rest migrate when their files are touched. No `fakeRepo()`
  builder was needed — storing rows covered every override.
- [x] (0192bf96) Move Copilot/GitHub ownership (host helpers, token exchange,
  account-type detection, management-plane calls, device-flow requests) into
  `@vibe-llm/provider-copilot/github`; gateway copies and dead constants
  removed; one table test in provider-copilot covers every call × host.
- [x] (b8818763) Provider plugin hooks `publicConfig` / `normalizeConfig` /
  `probeConfig` replace the gateway's per-kind switches for the dashboard DTO,
  generic create/edit validation and draft probing; SDF validation moved into
  provider-sdf. Pinned by a secret-in-every-field characterization test and an
  architecture test. Remaining per-kind code is Copilot's genuinely special
  credential flows (request-supplied fallback token, session prewarm) and
  import/export opaque-compatibility parsing.
- [-] Provider-owned dashboard form descriptors — UI rewrite of
  `UpstreamFormModal`; worth doing with the next provider addition.
- [-] Retire the root v1 `src/` — confirm nothing deploys the legacy worker
  first.

## Verification of the adopted set (2026-11-19)

37 commits on `vNext` after `547497a4`. Each adopted item has a test that
failed on the old code and passes now (named in its commit). Whole tree after
merging: `bun run typecheck` clean; `test:fast` 7113 pass, `test:slow` 134
pass, `test:research` 316 pass; `test:isolation` 692 files, 0 failing; lint 0
errors (38 warnings, below the earlier 41). `test:isolation` caught three
tests the package-level runs missed, all encoding pre-adoption behavior
(`codex-credential-effects`, `custom-path-overrides`, `responses-compact.e2e`);
they were updated to the adopted contract (`60892d6c`, `88e09031`).

A single-process `bun test` over all 740 files was SIGKILLed twice on this
16 GB machine under other load; the tiers ran to completion.

## Conventions

The resulting test conventions and architecture guards are documented in
`vnext/AGENTS.md` §4 and §7.

## Decisions needed

1. **#614 defaults.** The selective system-turn downgrade exists as flag
   `demote-disallowed-system-to-user`, off everywhere. The reference enables
   it for Claude Code and for all Claude models on Copilot.
2. **#572 / #601 policies.** Compact shim on by default for every provider;
   gateway-wide stateless-Responses flag and the Codex `store` default.
3. **#543 Lite tool positions.** Keep hoisting caller `additional_tools`, or
   rewrite the Lite encoder to keep them positional like the reference.
4. **#619 hosted tools on non-Responses targets.** The reference rejects a
   request carrying e.g. `file_search` for a Chat/Messages upstream; vNext
   still drops it, because throwing would turn Codex requests with
   `web_search` into 400s when no server-tool plugin is active.
5. **#713 `/v1beta/models` shape.** The reference returns the OpenAI shape
   unless the caller identifies as a Gemini SDK; vNext keeps it Gemini-shaped.
6. **#724** send only `max_completion_tokens` to Chat targets.
7. **Catalog revision.** #559/#715 change catalog/pricing data; cached
   catalogs refresh on their own schedule unless `MODEL_CATALOG_REVISION` is
   bumped.
