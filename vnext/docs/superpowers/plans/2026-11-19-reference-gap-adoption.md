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

- [ ] #620 Gemini stream errors. Why: Google JS/Go SDKs only recognize a
  mid-stream error written as bare JSON. Current: `data: {"error":{message}}`
  and code/status dropped (`gateway/.../gemini/respond.ts:158`). Accept: the
  stream's last chunk parses as `{error:{code,message,status}}` with no
  `data:` prefix.
- [ ] #619 silently dropped input. Why: dropping input yields confident wrong
  answers. Accept: Gemini `inlineData` PDF → Chat `file` / Responses
  `input_file`; audio → `input_audio` (mp3 for audio/mp3 and audio/mpeg);
  other MIME throws; Messages `tool_choice` naming an undeclared tool throws;
  empty `reasoning_effort` passes through unchanged.
- [ ] #743 Anthropic tool input without deltas (Responses path). Accept:
  `tool_use input:{}` with no deltas → `arguments: "{}"`, not `""`.
- [ ] #702 empty repeated tool-call name (Gemini via Chat). Accept: fragments
  `{name:"bash"}, {name:"",…}` keep `functionCall.name: "bash"`.
- [ ] #703 Gemini thinking levels. Why: the wire enum is uppercase. Accept:
  LOW/MEDIUM/HIGH/MINIMAL → low/medium/high/minimal,
  THINKING_LEVEL_UNSPECIFIED → unset, on Chat, Responses and Messages targets.
- [ ] #717 empty reasoning. Why: empty thinking blocks are rejected by
  Anthropic. Accept: no thinking block unless text is non-empty or a signature
  exists; an empty first block does not shadow a later non-empty one.
- [ ] #712 upstream error details. Accept: a Responses `error` event keeps its
  message and code through JSON reassembly and Messages translation (type not
  collapsed to `api_error`); the following `response.failed` is consumed.
- [ ] #735 unframed SSE payload. Why: some upstreams end a stream with a bare
  (possibly multi-line) JSON error, which looked like a clean end. Accept:
  `data: {...}\n\n{"error":{"code":503}}\n\n` parses as two frames, the second
  marked raw; CRLF and multi-line handled.
- [ ] #739 standalone function_call_output. Why: Codex `/goal` context arrives
  as outputs without `call_id`; strict upstreams reject the request. Accept:
  `{type:"function_call_output", name:"goal", output}` without call_id becomes
  a user message `<external_goal>…</external_goal>`; missing name → 400.
- [ ] #557 payload isolation. Why: a translated request sharing objects with
  its source corrupted compact replay / repeated dispatch. Accept: no object
  in a translated target is reachable from its source or a previous target
  (nine pairs).
- [ ] #548 bounded namespace name allocation. Accept: allocation work linear in
  tools; names unique and ≤ 64 chars.
- [ ] #658 sparse/interleaved Messages streams in the web-search shim. Why:
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

- [ ] #558 hosted tools declared in `additional_tools` / `tool_search_output`.
  Accept: a nested `{type:"web_search"}` is rewritten in place and dispatched
  locally.
- [ ] #549 hosted-tool alias collisions. Accept: `allowed_tools` selecting
  `web_search` is rewritten to the alias; a history `function_call` named
  `web_search` makes the helper `web_search_2` instead of a 400.
- [ ] #631 thinking signature round trip. Accept: `signature: ""` returns as
  `""` (typeof check, not truthiness).
- [ ] #659 empty model list. Why: no reachable upstream is a normal state.
  Accept: `/v1/models` and `/models` with no upstreams → 200 empty list.
- [ ] #713 Gemini under `/v1`. Accept: `/v1/models/x:generateContent` behaves
  like `/v1beta`.
- [ ] #617 `x-reasoning-included: true`. Why: Codex otherwise re-estimates old
  encrypted reasoning and compacts too early. Accept: successful JSON/SSE/WS
  Responses carry the header; failures do not.
- [ ] #616 compaction shares the prompt cache. Accept: summarizer prompt is a
  final user message after the history; a tool-only reply retries once with the
  system-prompt variant; usage summed.
- [ ] #614 downgrade only disallowed inline system turns. Accept: a system turn
  after an assistant turn becomes `user`; one between user and assistant is
  kept; directive-only turns kept.
- [ ] #661 Chat encrypted `reasoning_details` through affinity. Accept: on a
  different upstream only that entry is removed and the request is marked
  degraded; on the same upstream it returns unchanged.
- [ ] #671 web-search page matching. Accept: exact URL, then canonical without
  fragment / trailing slash, then a single leftover pair.
- [ ] #657 Codex alpha-search fields. Accept: `response_length`, `domains`
  intersection, `recency` → time range; `null` = absent.
- [ ] #633 hosted-tool replay grouping. Accept: parallel calls replay as
  `fc_a, fc_b, fco_a, fco_b` with the upstream's raw argument string.
- [-] #572 compact shim on by default for every provider — policy.
- [-] #601 gateway-wide stateless Responses flag / Codex `store` default — policy.
- [-] #663 per-key upstream order randomization — new feature.
- [-] #741 cross-upstream failover — vNext picks one upstream per request; a
  failover design is a separate decision.

## Providers

- [ ] Codex #559 keep `context_window` and `max_context_window` separate.
- [ ] Codex #567 client version `0.159.3` (models hidden/rejected otherwise).
- [ ] Codex #570 quota expiry from exhausted windows only (a 429 at 100%/300s
  with a 40%/7d window must block for 300s, not 7 days).
- [ ] Codex #577 Ultra → last non-ultra effort via `multi_agent_reasoning_effort`.
- [ ] Codex #740 audio modality must not throw the catalog; keep unknown
  modalities; Fast only when advertised.
- [ ] Codex #543 Responses Lite keeps caller `additional_tools` positional and
  does not inject default instructions (verify before changing).
- [ ] Claude Code #716 per-model quota rejection must not block sibling models.
- [ ] Claude Code #571 `max_tokens` fallback 32768 (version pin stays
  deliberate).
- [ ] Claude Code #715 pricing rows for sonnet-5-5, haiku-5-5, fable-5-1.
- [ ] HTTP #638 decode `br` and `zstd` (and stacked codings) on socket responses.
- [ ] Custom #729 credential header per request protocol (Messages →
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
- [ ] Shared test-utils package (`jsonResponse`, `sseResponse`, stream readers,
  `withMockedFetch` with a lock and automatic restore, recording fetcher,
  stub upstream/model); migrate call sites incrementally.
- [ ] `fakeRepo(overrides)` over the real in-memory SQLite repo instead of
  hand-written no-op repos.
- [ ] Move Copilot/GitHub ownership (host helpers, token exchange,
  account-type detection, management-plane calls) into provider-copilot;
  remove the three `getCopilotBaseUrl` copies.
- [ ] Generic provider plugin hooks (credential, public DTO, export config) to
  replace per-kind branches in gateway; then provider-owned dashboard form
  descriptors.
- [-] Retire the root v1 `src/` — confirm nothing deploys the legacy worker
  first.
