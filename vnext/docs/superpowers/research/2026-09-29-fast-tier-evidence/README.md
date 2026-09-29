# Copilot Fast tier acceptance

Base: `791cc553a1860acc4ea2207ccf5051a5869764af`. Exact frozen product hashes accompany this evidence.

A shared catalog variant index now connects endpoint-supported Fast selection, actual response tier and the exact raw pricing key. Messages Fast requests without a known compatible lane fail before dispatch; Responses priority can fall back and reports the actual default. Explicit raw pins retain their exact ID, including dates. Raw catalog rows and both labels remain available through family metadata because vNext uses them as executable bindings. Codex advertises only the chosen upstream endpoint's known Fast lane. Count-tokens retains ordinary context/effort selection without acquiring a Fast lane.

## Verification

- Independent initial review found the count-tokens ordinary resolver regression and five outdated raw-pin test assertions. Fix1 review closes both with no new Important findings. Three provider-level regressions first failed and then passed; wire-model assertions remain exact.
- Writer initial focused suite:217pass/0fail; fix1 focused suite:25pass/0fail/99assertions. Workspace typecheck, purity and scoped lint pass.
- Final root `bun run ci:local`:4622pass/1existing skip/0fail; all types, purity, lint(0errors/35inherited warnings), dashboard build and Workers dry-run pass. Final log retained at `/tmp/vnext-c05-final-clean-ci.log` during this session.
- Root actual Bun loopback gateway attempt/responders through real CopilotProvider to a separate synthetic HTTP upstream and temporary SQLite:17cases pass. Native and translated Responses/Messages JSON/SSE retain actual tier, missing Messages Fast returns400 with zero dispatch, Responses fallback remains default, raw Fast pin is preserved,401 refresh retries identical prepared bodies exactly once, and count-tokens retains ordinary1m/effort raw models with no tier metadata.
- Actual SQL usage rows preserve incoming alias, public model, executed raw Fast key and the existing exact input/output prices10/50; base uses5/25. These are existing fixture pricing rows, not newly verified external prices or inferred multipliers.

Initial runtime exposed Messages JSON reassembly dropping speed and translated Responses dispatch omitting original sourceProtocol; both were fixed before initial freeze. Review then exposed the count-tokens regression, independently reproduced by the included failing runtime evidence. The initial full CI also identified the five old date-stripping assertions; tests now require the authoritative exact raw ID. A later lint gate caught two errors in the previously committed provider-context evidence script; this commit adds an explicit Bun serve import and removes an unnecessary template escape. Both evidence scripts now pass scoped lint and actual execution; the prior context fixture still passes its five concurrent cases.

## Boundaries and integration

Only synthetic credentials/catalogs and loopback HTTP were used; raw socket egress is blocked. This is actual provider/gateway/SQLite execution, not live account availability, external pricing, complete authorization-route coverage or workerd runtime acceptance. No new migration, environment variable, pricing row, deployment or push is included. C01 affinity and C07 Lite remain separate tasks.

Two protected user files overlap. Root verified a clean forward merge and exact reverse restoration of the original user bytes in both dirty worktrees before integration. The commit excludes their unrelated diagnostics/collaboration changes. All recovery stashes, untracked work and scratch snapshots remain preserved.
