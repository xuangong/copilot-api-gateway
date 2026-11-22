# Upstream groups with quota balancing

Status: implemented on branch feat/upstream-quota-balancing (2026-11-22).

## Motivation

The owner routes model traffic through several GitHub Copilot accounts. Each account has a monthly allowance of GitHub AI Credits that resets at 00:00 UTC on the first day of the month; unused credits are forfeited and usage beyond the allowance is either billed or blocked. Today routing is a fixed priority list: every request goes to the first eligible upstream, so one account is used up while others sit idle (on 2026-11-22: one account at 98 %, another at 9 %).

**Primary goal: minimise the chance that any single account's allowance is exhausted.** The owner wants to group accounts and spread usage so that no account runs out while others still have allowance ("quota balancing"), while keeping prompt-cache hits high (96.9 % cache-read share today) and keeping reads of GitHub's quota endpoint rare, because frequent reads are an account risk.

## Decisions

- **Groups of Copilot upstreams, ordered as one item.** An upstream belongs to at most one group. A group takes its own place in the routing order next to ungrouped upstreams and is reordered as a unit; its members have no static order — they are ordered dynamically by the balancing rule for each request. If the group cannot serve a request, matching continues with the next item. v1 supports Copilot upstreams only (their quota can be read; other kinds have no comparable allowance).
- **Balance by session, not by request.** A new session is assigned to one member and stays there; only a session's first request is balanced. Switching accounts mid-session would discard the prompt cache.
- **Lowest projected month-end share first, with a tolerance band.** A new session goes to the member whose allowance is projected to be least used at the end of the month, counting the usage outside the gateway that the gateway cannot steer; members within 5 percentage points of that minimum count as equally low and are chosen between by a stable hash of the session. Accounts whose owners use them heavily elsewhere therefore receive less gateway traffic, which evens out the risk of running out. **Everything is compared as a percentage of each member's own allowance, never as an absolute amount**: accounts have different (and changing) entitlements, so no rule compares one member's used amount with another's.
- **Real quota is the source of truth, read rarely.** Used share comes from GitHub's quota snapshot (the same data the Users page shows), read a few times a day per account; between reads an adaptive estimator adds the gateway's own recorded usage (converted by a learned factor) and extrapolated outside usage, re-learns after every read, and reads more often when its predictions were off. Manual calibration is the fallback for accounts whose quota can't be read.
- **Two lines.** At 90 % estimated used (soft line) a member takes no new sessions; its existing sessions continue. At 95 % real used (hard line) the member is cut off automatically: it serves nothing, every session moves to another member chosen by the balancing rule, and it comes back after the monthly reset.
- **Long sessions are rebalanced at cheap moments.** A session that resumes after being idle longer than the prompt cache lives is re-chosen for free; a session on a member far above the group minimum is moved once in a while, paying one cache miss.
- **When no member can take the request, the group is skipped.** Matching continues with the items after the group; only if nothing in the whole order can serve the request does the client get `503` with `Retry-After`. The default policy `stop` never uses a member at or above the soft line for new sessions; the group setting can switch to **allow overage**, which lets new sessions use members up to the hard line and shows a dashboard warning.
- **Dashboard only**, no other notifications. The Users page keeps reading quota live (it is opened rarely).

## Grouping and routing

A group has `id` (`ug_` + 32 hex), `owner_id`, `name`, `enabled`, and settings:

| setting | meaning | default |
| --- | --- | --- |
| `toleranceShare` | band above the minimum used share treated as equal | 0.05 |
| `softShare` | estimated used share at which a member stops taking new sessions | 0.90 |
| `hardShare` | used share at which a member is cut off entirely | 0.95 |
| `idleRebalanceMinutes` | idle time after which a resuming session is re-chosen (cache is cold) | 10 |
| `migrateShare` | projected-share gap above the group minimum that moves an active session | 0.10 |
| `burnHorizonHours` | how far the recent gateway burn rate is projected forward | 6 |
| `heavySessionUsdPerHour` | a session spending at least this much per hour (gateway cost) is "heavy" | 5 |
| `migrateMinHours` | minimum time between two forced moves of one session | 12 |
| `exhaustedPolicy` | `stop` or `overage` | `stop` |
| `readIntervalHours` | scheduled quota read interval per member | 6 |
| `confirmShare` | estimated used share that triggers an early confirming read | 0.90 |
| `driftShare` | change in estimated share since the last read that triggers an early read | 0.10 |
| `sessionIdleHours` | idle time after which a session assignment expires | 24 |

Membership is `upstreams.group_id` (nullable). Only upstreams of the group's owner (or global upstreams for an admin-owned group) can join. A group has its own `sort_order` in the same ordering as upstreams (owner, then `sort_order`), so the dashboard reorders a group and ungrouped upstreams together; a member's own `sort_order` is ignored while it is in a group.

Routing walks the ordered items top-down as today:

- an ungrouped upstream is used if it can serve the request (visible, enabled, allowed for the key, serves the model, not paused) — unchanged;
- a group is used if at least one member can serve the request and is available for it (see Assignment); the member is chosen dynamically by the balancing rule; otherwise the group is skipped and matching continues with the next item.

With a per-key upstream whitelist (ordered `upstream_ids`), the whitelist order replaces `sort_order` as today; a group then sits at the position of its first whitelisted member, and only whitelisted members are considered.

Balancing does not apply to:

- pinned requests (`up_<id>/<model>`), which go to the pinned upstream as today;
- requests with affinity route constraints (owned opaque state already binds them to an upstream);
- a group with a single eligible member (it is used directly).

## Session identity

The session key is a SHA-256 of the API key id plus the first available of:

1. a client session identifier: `prompt_cache_key` (Chat Completions / Responses, read before it is stripped), Claude Code's session id (`x-claude-code-session-id` header or the session part of `metadata.user_id`), Codex `session_id` / `conversation-id` headers;
2. otherwise the system prompt plus the first user message of the request (stable as the conversation grows).

Requests with neither (e.g. a bare single message without system prompt) still get a key from that message; such one-off requests simply land on the least-used member.

## Assignment

`session_assignments(group_id, session_key, upstream_id, created_at, last_seen_at, moved_at, recent_cost_usd, recent_cost_at)` (`recent_cost_usd`: the session's exponentially weighted gateway spend over the last hour as of `recent_cost_at`, used to tell heavy sessions), primary key `(group_id, session_key)`. Lookups go through a per-isolate cache; `last_seen_at` is written at most every `min(10, idleRebalanceMinutes / 5)` minutes per session (so a stale stored value can never make an active session look idle); rows idle longer than `sessionIdleHours` are deleted by maintenance.

For a request in a group slot:

1. If an assignment exists and its upstream is still an eligible member (in the group, enabled, not paused or cut off, serves the model, allowed for the key), keep it, unless:
   - **idle rebalance (free)**: the session's last request was more than `idleRebalanceMinutes` ago — the upstream prompt cache has expired, so the session is re-chosen by step 2 at no extra cost (it may land on the same member). A heavy session (its own gateway spend in the last hour ≥ `heavySessionUsdPerHour`) is re-chosen without the tolerance band, i.e. it goes to the single lowest member, so heavy sessions are spread across members;
   - **forced move (one cache miss)**: the member's projected share exceeds the lowest eligible member's by more than `migrateShare`, and the session has not been moved in the last `migrateMinHours` — it is re-chosen by step 2.
   The soft line alone does not move existing sessions.
2. Otherwise choose among eligible members whose estimated used share is below `softShare`:
   - projected share = (estimated used + outside-usage rate `o` × hours left in the month + the member's recent gateway burn rate × `burnHorizonHours`) ÷ entitlement (see Quota estimates) — the burn term makes a member that is currently running heavy sessions look fuller before its used share catches up;
   - `min` = the lowest projected share;
   - band = members with projected share ≤ `min + toleranceShare`;
   - pick the band member with the highest `hash(session_key, upstream_id)` (rendezvous hashing).
   Write the assignment (insert-or-replace).
3. If no member is below the soft line:
   - `stop`: the group is skipped for this new session and matching continues with the next item; if nothing later can serve it, the client gets `503`, error code `group_quota_exhausted`, `Retry-After` = seconds until the next 00:00 UTC on the 1st (or the earliest moment another candidate becomes available), message naming the group (owner-visible names only, as for protection);
   - `overage`: choose by step 2 ignoring the soft line (still excluding cut-off members), and raise the dashboard warning.

Sessions bound to a member by affinity (owned opaque state such as Claude thinking signatures or encrypted reasoning) are never moved by idle rebalance or forced moves; balancing compensates for them only through new sessions.

## Hard cut-off at 95 %

- When a real read shows used share ≥ `hardShare`, the member is cut off: the gateway inserts a protection pause on the upstream with reason `quota_exhausted` and `ends_at` = the next 00:00 UTC on the 1st. Routing skips it like any paused upstream, migratable sessions are re-chosen by the balancing rule on their next request, and the global banner shows the cut-off.
- When the estimate reaches `hardShare` first, a read is triggered at once; if the read floor does not allow it yet, the member is cut off provisionally on the estimate and the next read confirms or lifts it.
- Sessions bound to the member by affinity cannot move: their requests get `503 upstream_paused` with a message to start a new session, which is then balanced onto another member.
- Recovery: automatically after the monthly reset once a read confirms it, earlier if a read shows the share back below `hardShare` (e.g. a plan upgrade), or by the owner resuming the pause in the dashboard.
- v1 applies the cut-off to group members only (an ungrouped account has no other member to switch to).

Adding a member needs no special handling: with a low used share it receives new sessions until it catches up. Removing a member invalidates its assignments; those sessions are reassigned on their next request (one cache miss each).

## Quota estimates (adaptive)

The conversion between the gateway's cost and GitHub's quota is not a constant: GitHub may change per-token prices, discounts (e.g. Fusion, auto model selection), the flex allotment or its accounting, the gateway's price table may be wrong, and software outside the gateway (IDE, CLI, github.com, other tools) consumes the same allowance. The estimator therefore learns continuously from real reads and widens or narrows its read frequency by how well it predicted.

### Model

The estimator works in **shares**: `share = used ÷ entitlement`, with the entitlement taken from the latest read. For a member, between two real reads:

> Δshare (GitHub) = k × Δcost (gateway, USD) + outside usage

- `k` converts gateway USD into share of the allowance (share per USD); it is learned per member, so it is independent of the snapshot's unit and of the plan size;
- outside usage is everything GitHub counted that did not go through the gateway.

Per member the estimator keeps `k`, an outside-usage rate `o` (share per hour), and the last prediction error.

### Estimate at any moment

> estimated used share = last read share + k × gateway cost since the read + o × hours since the read

It is updated as each gateway request's cost is recorded, so balancing always sees the gateway's own traffic immediately; only the outside part is extrapolated. After the monthly reset (and before the first read of the new month) the base is 0. Projected month-end share = estimated used share + o × hours left in the month + k × recent gateway burn rate (USD per hour, exponentially weighted over the last hour) × `burnHorizonHours`; it drives the choice of member, while the soft and hard lines use the used share.

### Learning after each read

Each read closes an interval with Δused, Δcost and Δt:

- **k**: when the snapshot's unit can be tied to the plan (e.g. the entitlement is a normalised 1,000,000 parts of the monthly allowance), `k` starts from entitlement ÷ the plan allowance in USD. In every case it is re-learned from recent intervals (last 7 days, exponentially weighted towards recent ones) as a low quantile of Δused ÷ Δcost over intervals with Δcost ≥ $1 — outside usage only ever raises that ratio, so the low end approximates `k`. Price, discount or accounting changes are absorbed within a few reads; the gateway's price table only needs to be relatively right.
- **o**: the residual Δused − k × Δcost (floored at 0) divided by Δt, smoothed with an exponential moving average, so outside consumption starting or stopping shows up within a few reads.
- **prediction error**: the estimated share just before the read minus the real share, in percentage points.

Intervals that cross a monthly reset, show a falling share, or span an entitlement change are not used for learning (see below).

Before enough intervals exist (new member, new month, `k` unknown), the estimator errs high (a conservative `k` and the recent `o`), so an under-estimate can't send extra sessions to a nearly exhausted account.

**Peer-seeded `k` (D33).** A member whose own `k` is not learned (fewer than 3 usable intervals) uses a `k` seeded from peers on the same plan instead of the group median / global default, when any exist: the other members of any group of the same owner whose `k` IS learned (at least 3 usable intervals), with the same latest entitlement, snapshot key and unit form (all known; not unlimited). Seeded `k` = the MAX of the peers' learned `k` x 1.2 (`k` is a low quantile and plans mix models, so the highest peer is the cautious choice). The seed drives estimates, projections, the soft line and the status display, but is not learned: a provisional cut-off on the estimate still needs the member's own learned `k`. The failing-read estimate (D32) uses the larger of the seed and what it used before, so it is never less conservative. From 3 own intervals the member's own `k` is used. With no qualifying peer nothing changes. Peers are found with one query for all members (`listPlanFacts`), cached with the facts TTL; a failed load keeps the previous answer or falls back to the current behaviour. The status reports the source per member: `own`, `peer` (with the peer count) or `default`.

### Entitlement changes

The entitlement (the allowance's total) can change at any time: a plan upgrade or downgrade, or GitHub changing the flex allotment or its accounting. Every read records its entitlement and all shares use the latest one. When a read's entitlement differs from the previous read's:

- the interval spanning the change is dropped from learning (neither `k` nor `o` nor the prediction error is updated from it), and the learning window restarts at the changed read: earlier intervals no longer count;
- the learned `k` and `o` were derived against the old entitlement; they are rescaled by `old ÷ new` (the same credits are a different share of the new total) and the member counts as having few intervals again, so the conservative bias applies until it has re-learned;
- the next read is brought forward to the minimum interval (1 h, subject to the floors) so the new parameters are confirmed quickly;
- the change (`from`, `to`, time) is stored and shown on the dashboard ("entitlement changed from X to Y").

### Adaptive read frequency

- The read interval per member starts at `readIntervalHours` (6 h).
- After a read with |error| > 5 points the next interval halves (floor 1 h); after reads with |error| < 3 points it grows back by 1.5× up to `readIntervalHours`.
- An early read is due when the estimated share has moved by more than `driftShare` (10 points) since the last read, or reaches `confirmShare` (90 %), the soft line or the hard line.
- All triggers respect the floors in "Reading quota".

### Visibility

The dashboard shows per member the last read and its source, the last prediction error, the current read interval, `k` trend, the outside-usage share of the last day and the latest entitlement change ("entitlement changed from X to Y"), so the owner can see which accounts are consumed elsewhere and how reliable the estimate is. Large or persistent errors are listed in the group status.

The first implementation task captures a raw quota response for each kind of account and confirms which snapshot reflects AI Credits, its unit and reset behaviour; balancing uses only shares, so the unit affects the starting `k` but not the rule.

## Reading quota

Reads use the member's own GitHub credential and proxy chain (the path the Users page already uses) and are driven by scheduled maintenance. Per member:

- **scheduled**: at the member's current adaptive interval (6 h at most) with ±30 minutes of random jitter, members staggered;
- **on joining a group**: once;
- **early**: drift, confirm, soft-line or hard-line triggers above;
- **monthly**: the first read after the reset is due within the jitter window;
- **manual**: a Refresh button on the dashboard;
- **page open**: opening the Upstreams page reads members not read in the last 10 minutes (see Dashboard);
- **floor**: never two reads of the same member less than 1 hour apart (10 minutes for manual refresh). A failed read counts toward the floor and backs off (1 h, 2 h, 4 h, capped at `readIntervalHours`). At most 12 GitHub reads per member per UTC day (manual refresh exempt). A member that has never been read successfully takes no new sessions until it is read or calibrated (a missing read cannot look like 0 %); the dashboard and banner flag it.

The Users page keeps its live read and is not affected.

## Manual calibration

For members whose quota can't be read, or to correct an estimate, the owner enters used and entitlement (or used share) as of a time; it is stored as a `manual` read and used like a GitHub read. A new member without any read takes no new sessions until it is read or calibrated, so a missing read can't look like 0 %.

## API (session-guarded, owner-only like upstream management)

- `GET/POST /api/upstream-groups`, `PATCH/DELETE /api/upstream-groups/:id` (name, enabled, settings).
- `PUT /api/upstreams/:id/group` `{ groupId | null }`.
- `GET /api/upstream-groups/:id/status` → per member: used share (estimated), last read (time, source, values), k, outside-usage rate, last prediction error, current read interval, eligibility and reason, active session count; group state (`normal` / `stopped` / `overage`).
- `POST /api/upstreams/:id/quota/refresh` (rate-limited by the floor).
- `POST /api/upstreams/:id/quota/calibrate` `{ used, entitlement, at? }`.

## Dashboard

- Upstreams page: a group is shown as one card in the upstream list and is dragged/reordered as a unit among ungrouped upstreams; its members are listed inside it without a manual order. Groups can be created, renamed, enabled, configured and deleted, and upstreams moved in or out.
- Each member row in a group card shows the same quota figure as the Users page (used / entitlement and a used-share bar), plus: data source and age ("GitHub, live · just now" or "estimate · last read 2 h ago", the estimated part shaded), projected month-end share, soft and hard line markers, cut-off state, active session count, outside-usage share, last prediction error, current read interval, and Refresh / Calibrate.
- **Always the latest numbers:** opening the Upstreams page reads quota live for the group members, like the Users page does, and the result is stored as a real read that also calibrates the estimator. A member read less than 10 minutes ago reuses that read instead of reading again, so switching pages can't turn into frequent reads. While the page is open and visible, the estimates refresh every minute from the gateway's own usage (no GitHub reads), so the figures move with traffic.
- The Users page keeps its own live read and is not changed.
- The global banner (from upstream protection) also shows a member that is cut off and a group that is skipped because no member can take new sessions, or that runs in `overage`.
- EN and ZH; local time.

## Retention

Maintenance deletes idle session assignments, quota reads older than 90 days, and rows of deleted groups or upstreams, in bounded chunks.

## Testing

- Session key derivation for each client shape and the fallback; stability as a conversation grows.
- Ordering: a group as one item among ungrouped upstreams; dynamic member order; group skipped when no member can serve (model missing, all at the soft line, cut off or paused) and matching continues; 503 only when nothing later serves; per-key whitelist positions.
- Selection: lowest projected share (an account with heavy outside usage or a heavy running session gets fewer sessions), tolerance band, heavy sessions placed without the band, rendezvous tie-break, soft line, sticky assignment, idle rebalance, forced move with its gap and minimum interval, affinity-bound sessions never moved, reassignment when a member leaves, is paused or is cut off, pins and affinity bypass, single member, per-key whitelist.
- Hard cut-off: real read ≥ 95 % pauses until the monthly reset; provisional cut-off on the estimate when a read is not yet allowed; lifted by a lower read, the reset or the owner; bound sessions get 503.
- Exhaustion: `stop` 503 with `Retry-After` to the next month; `overage`.
- Estimates: read + k × gateway cost + outside rate × time; everything in shares, never absolute amounts across members; entitlement change (interval dropped, `k`/`o` rescaled, conservative again, early read, change shown); k re-learning after a simulated price/discount change; outside-rate tracking when external usage starts/stops; conservative bias with few reads; monthly reset; unlimited.
- Adaptive reads: interval halves after large errors and recovers after small ones; drift, confirm, soft-line and hard-line triggers; floors never exceeded.
- Read scheduling: interval with jitter, join, confirm, monthly, manual, floors, backoff; no read beyond the floors under any trigger mix.
- Repo contract on SQLite and D1; API owner-only; dashboard rendering; end-to-end through the real app with two fake Copilot members.

## Out of scope (later)

- Failover to another member on a 429 or quota error before any output (phase 2).
- Groups of non-Copilot upstreams; weighted or cost-optimising strategies.

## Risks

- Pooling accounts that belong to different people may conflict with GitHub's terms (account sharing, circumventing limits) and can get accounts restricted. Membership is the owner's explicit choice; Business/Enterprise accounts draw from an organisation's pool and should normally stay out of groups.
- Estimates between reads miss usage made outside the gateway (e.g. in an IDE); confirming reads at the soft and hard lines limit the effect.
- An affinity-bound session that runs for days stays on its member until the hard line cuts it off; the client then has to start a new session.
