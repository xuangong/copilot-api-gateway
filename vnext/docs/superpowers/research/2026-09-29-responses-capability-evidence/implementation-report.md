# C12 capability publication — fix 1 frozen implementation

Base commit: `4f8983af9d433d75b41558f8bf9931e571c30385`. Product files are frozen at the updated hashes in `task-C12-capability-frozen-sha256.json`; `task-C12-capability-owned-paths.txt` lists all 22 owned paths, including six new files. Root retained the pre-fix snapshot in `task-C12-capability-fix1-base`. No commit, push, deployment, migration, live configuration, or production data change was made.

## Result

- `GET /api/capabilities` is authenticated, `Cache-Control: no-store`, and reports `codex.responsesWebSocket` with `available`, `mode: "single_turn"`, explicit `multiplex`, `fork`, and `reconnectHistory` false, and `maxConnectionOutboundBytes`. Bare Hono defaults to false/null. Bun native HTTP ingress reports true/null; Workers native HTTP ingress reports true with the shared 16,777,216-byte unobservable connection output limit.
- The capability is held in request-scoped `AsyncLocalStorage`, installed only around unmatched HTTP `app.fetch` in both accepted native adapter factories. The platform-facing package path re-exports only the wrapper; the gateway reader stays internal. The capability read skips optional Copilot upstream prewarming; it makes no upstream discovery or database write.
- Codex catalog synthesis takes an explicit optional ingress boolean, default false. Matched and unmatched entries derive `prefer_websockets` from the installed ingress, including when source catalog metadata disagrees. Public OpenAI-shaped model metadata is untouched.
- Dashboard Codex TOML fetches the same-origin capability with credentials, `no-store`, and `AbortSignal`. Only a complete, valid, confirmed response enables `supports_websockets = true`; unknown, loading, malformed, unauthorized, failed, or aborted reads remain false. A generation gate aborts prior reads, and render-time origin/session/key scope matching hides stale true immediately. The snippet escapes TOML basic strings, including quotes, backslashes, controls, Unicode and newlines. Existing Claude/Gemini snippets and layout are unchanged.

## Fix 1 review delta

- R1: Replaced the fabricated `Repo` fixture and substituted credential results with a migrated temporary SQLite file and real owner, API key, session, and Copilot upstream rows. The capability route test observes outbound fetch calls and SQLite `total_changes()` around the read. The concurrent scope barrier now waits outside database operations and uses real key/session authentication.
- R2: Split active-signal fetch rejection from pre-abort. Tests assert one fetch call for rejection and zero for pre-abort, with false returned in both cases.
- R3: Added a one-symbol platform re-export for `withResponsesWebSocketIngress`; the package entry no longer exposes the internal reader.
- R4: The lint command's multi-project configuration advisory is recorded below as tooling output, separate from changed-file diagnostics.

## Verification before fix 1 freeze

- Focused Bun tests: 35 passed across dashboard capability/snippet, gateway capability/catalog, and Bun native adapter files. Tests include bare Hono false plus 426, real SQLite key/session auth, zero outbound call and zero SQLite writes, concurrent wrapped/unwrapped scope, catalog source disagreement, TOML round-trip, malformed/fetch-rejection/pre-abort reads, and same-document scope switches. The test barrier precedes `app.request`; Root's native runtime probe covers held in-handler isolation.
- Native workerd focused test: one passed, confirming `/api/capabilities` true/16,777,216/no-store alongside the four actual authenticated 101 upgrade paths.
- Typecheck: dashboard, gateway, platform-bun, platform-cloudflare passed.
- ESLint on all changed TypeScript/TSX product paths passed with no changed-file warnings or errors. Its sole output was the multi-project configuration advisory from tooling. `git diff --check` passed. All 22 modified/new files passed explicit trailing-whitespace, CR, and final-newline checks.
- Root's initial pre-fix full CI passed (4,955 tests, one skip, zero failures) and Root separately reported passing mutable actual workerd/D1, Bun, and browser probes. Those runs precede fix 1. Root owns the post-fix frozen full CI, runtime/browser rerun, review, and integration; this report does not claim those pending gates.

Boundary: this publication describes tested client-to-gateway single-turn Responses WebSocket ingress. It does not claim native upstream WebSocket transport, multiplex/fork, reconnect history, universal Codex-version compatibility, peer acknowledgements, automatic reconnection, or production deployment.
