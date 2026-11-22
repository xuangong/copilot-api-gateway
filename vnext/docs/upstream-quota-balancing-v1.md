# Upstream quota balancing (v1)

Reference for operators. Design: `docs/superpowers/specs/2026-11-22-upstream-quota-balancing-design.md`; plan: `docs/superpowers/plans/2026-11-22-upstream-quota-balancing.md`. Code: `packages/gateway/src/quota-balance/`, routes in `packages/gateway/src/control-plane/quota-balance/`.

## Goal

Copilot accounts have a monthly allowance that resets at 00:00 UTC on the 1st; unused allowance is forfeited. The goal is to minimise the chance that any single account is exhausted while others still have allowance. A group of Copilot upstreams spreads new sessions towards the account with the most room, keeps a session on one account (switching discards the upstream prompt cache) and reads GitHub's quota endpoint rarely.

Everything is a share (a fraction) of each account's own allowance. Absolute amounts are never compared, so accounts with different or changing entitlements, or an unknown unit, behave the same way.

## Groups and routing

- Only Copilot upstreams with a stored GitHub credential can join, one group each, and a member must have the same owner as the group (an admin may create a global group, owner `''`, for global upstreams). Grouping is device-local like `enabled` and `sort_order`: it is not part of the sync documents.
- A group is one item in the routing order. It has its own `sort_order`, in the same number space as its owner's ungrouped upstreams, and is dragged as a unit in the dashboard. A member's own `sort_order` is ignored while it is in a group; members have no order of their own, the balancer orders them per request. A member removed from its group is placed right behind it.
- Fall-through: if no member of the group can serve the request (the model is missing, every member with a read is at the soft line, cut off or paused, or no member has been read yet), the group is skipped and matching continues with the next item of the order. A request fails only when nothing in the whole order can serve it (see "503 answers").
- Not balanced: pinned requests (`up_<id>/<model>`) and requests whose owned opaque state (Claude thinking signatures, encrypted reasoning, other affinity route constraints) binds them to an upstream. They touch no assignment, so an affinity-bound session stays where its state lives until that member is cut off. A group with a single eligible candidate skips only the ranking; the soft and hard lines still apply. With a per-key upstream whitelist, only whitelisted members take part and the group sits at the position of its first whitelisted member.
- Requests without a session (embeddings, images, decisions, `count_tokens`) are balanced per request, nothing is stored: members ranked by projected share (below), a random tie-break inside the tolerance band. Chat completions, messages, responses (including the WebSocket sessions), Gemini and Ollama `/api/chat` are balanced by session.
- Embeddings, images and decisions respect the soft line like new sessions. `count_tokens` consumes no premium quota: it ignores the soft line and ranks every member that is not cut off, members without data last.

## Sessions

The session key is the first 32 hex digits of a SHA-256 of the API key id and the first available identity:

1. `prompt_cache_key` of the body;
2. Claude Code's `x-claude-code-session-id` header, or the session part of `metadata.user_id`;
3. Codex `session_id`, `conversation-id` or `conversation_id` headers;
4. otherwise the system prompt plus the first user message (each cut to 2 KiB; Claude Code's changing billing attribution block is ignored).

It is derived from the parsed body before any interceptor can strip `prompt_cache_key`. A request with no identity at all is balanced like a sessionless one. Caveats:

- The header names are assumed from the clients' observed behaviour, not a documented contract.
- Clients that reuse one `prompt_cache_key` for unrelated conversations are treated as one session: they stick to one member together. Keys are hashed with the API key id, so different keys never collide.
- Ollama `/api/chat` carries no session id on the wire; the conversation is identified by the system prompt and first user message, so it sticks while those stay the same.

Assignments live in `session_assignments` (per-isolate cache, 60 s TTL; `last_seen_at` is written at most every `min(10 min, idleRebalanceMinutes / 5)`, at least 30 s) and are deleted after `sessionIdleHours` without a request.

## Assignment

For each group the request meets:

1. No assignment, or the assigned member is no longer an eligible candidate (left the group, disabled, paused, cut off, does not serve the model, not whitelisted): the session is chosen like a new one and the assignment is created or moved. A session whose member was cut off therefore cannot move to a member at the soft line.
2. Idle rebalance: when the session has been idle longer than `idleRebalanceMinutes` (the prompt cache is cold) it is chosen again for free. A heavy session, whose recent spend (exponentially weighted over 1 h) is at least `heavySessionUsdPerHour`, is placed without the tolerance band (the single lowest member). `heavySessionUsdPerHour: 0` switches this off.
3. Forced move: an active session moves once (one cache miss) when its member's projected share exceeds the lowest eligible member's by more than `migrateShare` (10 points) and it was not moved in the last `migrateMinHours` (12 h). Members that take no new sessions (at the soft line under `stop`, no data, facts unavailable) are never the baseline.
4. Otherwise it stays; the other members stay as fallbacks if the assigned one cannot be dispatched, but the assignment only follows a request that was served by its member. There is no retry on another member after output started.

Selection: members with a read and below the soft line are ranked by projected month-end share. Members within `toleranceShare` (5 points) of the lowest are equal and the highest `hash(session, upstream)` score (rendezvous) wins; the rest follow by projected share. A group is tried first when it is first in the order, and a new session is stored before dispatch then; otherwise it is stored once one of its members has served.

A member that has never been read (or calibrated) takes no new sessions. A member whose facts cannot be loaded and are not cached is eligible but ranked last. Under `exhaustedPolicy: overage` the soft line is ignored for new sessions (members up to the hard line) and the dashboard warns. Balancing is fail-open: any internal error leaves the original order.

## Lines

| line | default | effect |
| --- | --- | --- |
| soft (`softShare`) | 90 % | on the estimated used share: the member takes no new sessions under `stop`; running sessions continue. The soft line alone never moves a session. |
| hard (`hardShare`) | 95 % | the member is cut off until the next 00:00 UTC on the 1st: a protection pause with reason `quota`. Its sessions are chosen again on their next request, sessions bound to it by opaque state get `503 upstream_paused`. |

Hard line details:

- A real read at or above the line cuts the member off at once. A real read below the line lifts a quota pause. An owner Resume lifts it too, and then no cut-off from a read or estimate taken before the Resume applies; only a later real read at the line cuts again.
- The estimate cuts provisionally when it reaches the line before a confirming read is allowed, but only when `k` is learned (at least 3 usable intervals). With the fallback `k` the estimate is deliberately high: reaching the line only asks for a read. The next real read confirms (the row is updated in place) or lifts a provisional cut-off; an estimate never lifts one.
- Exception (failing reads): a member that HAS been read successfully (GitHub or manual) at some time, whose reads keep failing (at least one failed attempt, and either no successful read this month or a failed last read older than two read intervals) is eligible on a conservative gateway-only estimate (the larger of the group's learned `k` and the default, its last outside rate, the month's gateway cost when it has no read this month). Because nothing real protects it, that estimate may cut it off provisionally even with `k` not learned and under `overage`. The dashboard flags such a member and the banner names it. A member that was never read successfully is not covered: a missing read must not look like 0 %, so it stays ineligible for new sessions (`no_read`) until a read or a calibration succeeds, however often the join read failed. Status and alerts flag it as `read_failing` with reason `never_read`, so the banner names it.
- Month start: nothing is read in the first 30 minutes after 00:00 UTC on the 1st (GitHub may still serve last month's figures). A real read taken inside that window never cuts, and is not used as the month's base; the estimate uses the month's gateway cost until a later read. The first read of a month is due 30 to 60 minutes after the reset. Calibration `at` must be after that window too.
- A quota pause may coexist with an error-protection pause of the same upstream.

## Estimates

Between reads: estimated used share = last read share + `k` x gateway cost since the read + `o` x hours since the read. After the monthly reset the base is zero (plus the month's gateway cost and outside usage) until the first read of the month.

- `k` (share per gateway USD) is re-learned after every read. Intervals qualify when they have at least $1 of gateway cost, the same entitlement, snapshot and unit form, the same UTC month, and a share that did not fall. The estimator takes the 25 % quantile of share / cost over the last 7 days (half-life 1 day), so outside usage can only raise the ratio, but never below half the pooled ratio of the window. An interval whose share did not move although at least $1 was spent (GitHub's counter lagging) is merged into the next usable interval instead of counting on its own.
- Until 3 usable intervals exist, `k` is at least a conservative fallback: the median of the group's learned `k` values, else the constant `DEFAULT_K_SHARE_PER_USD` (0.1). `o` (outside usage, share per hour) is the residual of the latest usable interval after the gateway's own cost, seeded by the first one and smoothed by an EWMA (alpha 0.5) afterwards; it is only learned once `k` is learned (before that the residual would be zero by construction).
- Projected month-end share = estimated share + `o` x hours left in the month + `k` x recent burn (USD per hour, exponentially weighted over the last hour) x `burnHorizonHours`.
- Entitlement, unit and snapshot changes: every read records its entitlement and shares use the latest. When the entitlement differs from the previous read's, the spanning interval is not used, learning restarts from that read, `k` and `o` are rescaled by old / new when the factor is believable (0.1 to 10; otherwise they are reset), `k` is at least the fallback again until 3 new intervals exist, the read interval drops to 1 hour and the dashboard shows "entitlement changed from X to Y" for 7 days. A change of snapshot key or unit form restarts learning without that notice. A switch between unlimited and metered also restarts learning. An unlimited account is always eligible with share 0.

## Reads of the quota endpoint

Reads (`GET /copilot_internal/user`) use the member's own GitHub credential and the member's own proxy chain, from the maintenance sweep (every minute; with no group that costs one statement and the gateway reads nothing). The sweep loads the active pauses once, and starts no new member after 30 s (the remaining members continue next minute; a slow upstream cannot hold the maintenance run). Members of a disabled group are evaluated too (read on schedule, cut off at the hard line), because pinned and direct traffic can still reach them. If the proxy-aware fetcher is not configured the read fails closed and is recorded as a failure; it never leaves directly from the process. Each read has a 15 s timeout and the response body of a failed read is never read or stored.

- Scheduled every `readIntervalHours` (6 h) with +-30 min jitter, shorter after prediction errors above 5 points (halves, floor 1 h), longer again after errors below 3 points (x1.5, up to the setting). A scheduled read is never later than 30 to 60 minutes after the next monthly reset.
- Also: once on joining a group, within the window after the monthly reset, early when the estimate has moved more than `driftShare` from the last read or reaches `confirmShare`, the soft line or the hard line. Join, monthly and scheduled reads are staggered (at most 2 per sweep); the early triggers are not held back. Gateway cost recorded for a member also triggers an evaluation, at most once a minute per member per isolate.
- The page-open live read (`POST /api/upstream-groups/:id/live`, called when the Upstreams page opens) and a manual Refresh read at most every 10 minutes per member: a read within 10 minutes is reused. A member in failure back-off is not read on page open; Refresh may still try.
- Floors: never two attempts at a member less than 1 hour apart (10 minutes for manual and page-open reads); a failed read counts and backs off 1 h, 2 h, 4 h up to the read interval. The floor is claimed atomically in the database before any request leaves, so isolates, the sweep and page opens cannot get two reads through.
- Daily cap: at most 12 GitHub reads per member per UTC day across every trigger (join, scheduled, early, monthly, failed attempts included); manual Refresh and the page-open read are exempt and not counted, and stay under the 10 minute floor. At the cap a hard-line estimate can still cut provisionally (with a learned `k`).
- Joining and leaving: a membership change restarts the estimate (read base, cost counters, `k`, `o`) but keeps the read throttle (last attempt, failures and back-off, calibration floor, daily count), so leaving and rejoining cannot be used to read more often. The throttle row of a non-member is kept for 48 hours. Joining needs a stored GitHub credential (400 `no_credential`).
- Calibration (dashboard Calibrate; `POST /api/upstreams/:id/quota/calibrate`) stores a `manual` read for accounts whose quota cannot be read. It has its own 10 minute floor (a failed read or a page-open attempt does not block it), `at` at most 24 hours back and after the first 30 minutes of the current month, after the last read, used at most 1.5 x the entitlement, and the gateway cost since `at` is accounted for. Calibrations of a member are serialised.

## Cost recording

Gateway cost is recorded for group members only, in the background, next to every usage record (including embeddings): per member in 10-minute buckets and as a running total, and on the session's assignment (`recent_cost_usd`, decayed with a 1 h time constant) when the member that served is the session's member. The member's own isolate adds the cost to its facts at once, so balancing sees the gateway's own traffic immediately; other isolates see it within 20 s. A request that was not served by a group member costs one cached directory lookup.

## 503 answers

- `group_quota_exhausted`: nothing in the whole order can serve the request and every skipped group was skipped for quota (every member with a read is at or above the soft line under `stop`). `Retry-After` is the earlier of the next 00:00 UTC on the 1st and the end of a pause among the request's candidates. The message names a group only for its owner. The body follows the protocol of the path (Anthropic shape on messages).
- `upstream_paused`: every candidate is a protection pause, as in `upstream-protection-v1.md`; also a session bound by opaque state to a cut-off member.
- If any skipped group was skipped only because no member has data yet (no read), the answer is the generic one (no eligible upstream or model not found for the path), never a quota claim.
- The soft line applies to the estimated share and only to new sessions: a running session keeps being served by its member, including when every member is at the soft line.

## Dashboard

Upstreams page: a group is one card, dragged with the ungrouped upstreams; members are shown inside it without drag handles. Each member shows used / entitlement and share, where the figure comes from and how old it is ("GitHub, live", "estimate · last read 2 h ago"), the projection, the lines, cut-off state, sessions, outside usage, last estimate error, read interval, `k` trend and the last entitlement change. The page reads quota live when opened (plain statuses first, then one live call per group) and refreshes estimates every minute from the gateway's own data while visible. Group settings, members, Refresh and Calibrate are managed there.

The global banner (polled with the protection store) shows cut-off members (quota pauses, provisional ones marked), groups that cannot take new sessions (`stopped`), groups in `overage` and members whose reads keep failing. A group that has no data yet reports no stopped/overage alert, but a member that was never read successfully is named with `read_failing` (`never_read`).

## Settings (per group)

| field | default | range |
| --- | --- | --- |
| `toleranceShare` | 0.05 | 0 to 0.5 |
| `softShare` | 0.9 | 0.5 to 1, below `hardShare` |
| `hardShare` | 0.95 | 0.5 to 1 |
| `idleRebalanceMinutes` | 10 | 1 to 1440 (integer) |
| `migrateShare` | 0.1 | 0.01 to 1 |
| `burnHorizonHours` | 6 | 0 to 72 |
| `heavySessionUsdPerHour` | 5 | 0 to 10000 (0: off) |
| `migrateMinHours` | 12 | 0 to 720 |
| `exhaustedPolicy` | `stop` | `stop`, `overage` |
| `readIntervalHours` | 6 | 1 to 48 |
| `confirmShare` | 0.9 | 0.5 to 1, not above `softShare` |
| `driftShare` | 0.1 | 0.01 to 1 |
| `sessionIdleHours` | 24 | 1 to 720 (integer) |

Lowering `softShare` below the stored `confirmShare` lowers `confirmShare` with it; submitting a contradicting `confirmShare` explicitly is rejected. At most 16 groups per owner.

## API (browser session, owner only; admins see all)

`GET/POST /api/upstream-groups`, `PATCH/DELETE /api/upstream-groups/:id`, `GET /api/upstream-groups/:id/status`, `POST /api/upstream-groups/:id/live`, `GET /api/upstream-groups/alerts`, `PUT /api/upstreams/:id/group` (`{ "groupId": "ug_..." | null }`), `POST /api/upstreams/:id/quota/refresh`, `POST /api/upstreams/:id/quota/calibrate`. A non-admin never sees an upstream (name, id, numbers) they do not own.

## Storage and retention

Tables: `upstream_groups`, `upstreams.group_id`, `session_assignments`, `quota_reads`, `upstream_quota_state`, `upstream_cost_buckets` (migration 0028). Maintenance deletes idle assignments (per group `sessionIdleHours`), reads older than 90 days, cost buckets older than 10 days and rows of deleted groups or upstreams, hourly at the telemetry retention minute and again on the following minutes while a pass used a full chunk (5000 rows).

## Rollout

Apply migration `0028_upstream_quota_balancing.sql` before deploying the new code. Nothing changes until a group is created: with no group the data plane costs one cached directory lookup per request and no quota read ever happens.

## Known limits and risks

- Estimates between reads miss usage outside the gateway; confirming reads at the soft and hard lines limit the effect, and `o` is only learned after 3 usable intervals.
- An affinity-bound session that runs for days stays on its member until the hard line cuts it off. A session whose member was cut off while the other members are at the soft line gets `group_quota_exhausted` until one of them is below the line.
- No failover to another member on a 429 or quota error after dispatch (phase 2). Groups of non-Copilot upstreams are out of scope.
- `alpha/search` and other callers that enumerate candidates directly are not balanced: they ignore the soft line and use the plain order, with members of a group contiguous at the group's position.
- Listings that span owners (global or all-owners views) order groups and upstreams by `sort_order` across number spaces that are separate per owner; ties fall back to creation time and id, so the interleaving of different owners' items is not meaningful.
- A quota cut-off is a protection pause: it survives the member leaving or its group being deleted, until the 1st 00:00 UTC or an owner Resume.
- Gateway cost is lost for the estimate when its usage write fails (only the next real read corrects it).
- Costs are not recorded while the group directory cache cannot load (non-members are not recorded either); the estimate then runs behind until the next real read.
- Pooling accounts that belong to different people may conflict with GitHub's terms; Business/Enterprise accounts draw from an organisation's pool and should normally stay out of groups.
- The findings of the first implementation task (which snapshot reflects AI Credits, its unit, the reset field) are UNVERIFIED: no live GitHub credential was available. `premium_interactions` is assumed, `DEFAULT_K_SHARE_PER_USD` (0.1) is a placeholder rather than a measured value, and they are documented in the comment at the top of `packages/gateway/src/quota-balance/snapshot.ts`. Confirm them from a live capture through the dashboard relay before relying on the conservative fallback; the parser and synthetic fixtures remain (`snapshot.ts`, `tests/fixtures/copilot-quota/`).
