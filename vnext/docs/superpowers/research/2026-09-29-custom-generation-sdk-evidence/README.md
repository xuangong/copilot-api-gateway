# A06 custom generation official SDK acceptance (2026-09-29)

**Final SDK acceptance:** On verification HEAD `4dc04175d2cbe52b5f9d0b5502fb6d227bbdcefb` with the applied, uncommitted A06 source delta, the expanded nine-case run passed **9/9**, with exactly nine counted upstream requests. Chat Completions ordinary `function_call` JSON and SSE terminal items have `status: "completed"`. The malformed Messages custom `tool_use` stream produces an SDK-visible `error` and no false `response.completed`. This is runtime acceptance of the current dirty verification tree; independent review of the source delta is pending.

The preserved clean-HEAD baseline at `a2d86861dc0a963053084ca8c16ec71d43cfbecc` was red: four custom-tool requests each produced an SDK-visible 400, `Cannot translate custom tool declarations without reverse callable context`, before upstream. Four same-name function controls passed. The before/after difference isolates the custom-generation path.

## Run and isolation

From `/Volumes/Projects/copilot-api-gateway`:

```sh
bun run .worktrees/reference-adoption/.superpowers/sdd/2026-09-29-reference-adoption-follow-up/a06-generation-sdk/run.ts
```

The original four-custom-request red command exited 1; the initial eight-case green command exited 0. The expanded nine-case red command exited 1 with three failures. After the first repair, the nine-case command still exited 1 with only the Chat JSON function status failure. The final nine-case command exited 0. Exact SDK observations, captured upstream requests, and complete SSE event arrays are preserved in `a06-generation-sdk/results-red.json`, `results-green.json`, `results-negative-red.json`, `results-fix1-partial.json`, and `results-final.json`; `results-latest.json` is updated on every run. Each invocation creates a unique `a06-generation-sdk/runs/<UTC timestamp>-<pid>/` directory containing its own SQLite database, file root, and full `results.json`. The fixture queries Git at runtime and records `sourceHead`, `sourceDirty`, and `sourceStatus`. These runs used Bun 1.3.0 and the installed official OpenAI SDK 6.33.0. No packages were installed.

The SDK's custom `fetch` adapter sends the SDK-created `Request` to the real gateway `app.fetch` imported from `reference-adoption-verify`, and returns that real `Response`; it does not synthesize a gateway response. The gateway is bootstrapped with an isolated fixture API key and two Custom providers. A dedicated `127.0.0.1` ephemeral-port `Bun.serve` listener captures outbound requests and returns synthetic target Chat Completions or Messages JSON/SSE; it is stopped in `finally`. No live credentials, paid endpoint, commits, or persistent service were used. This proves the in-process gateway app route, not a separate gateway HTTP socket.

## Green contract encoded in the fixture

- Source request: one flat unconstrained `custom` tool named `emit_payload`, `format: { type: "text" }`, selected by `tool_choice: { type: "custom", name: "emit_payload" }`. The target must receive one function carrier with a required string `input` parameter and a named tool choice. The distinct ordinary function request uses the same name and must remain a `function_call` in the SDK response, proving per-request identity.
- Synthetic tool input is `Line "quoted" \\ path 你好🙂`. Chat JSON returns a native function `tool_calls` argument string with `{"input": ...}`. Messages JSON returns native `tool_use.input` with the same string property. The SSE endpoints fragment the JSON wrapper across the middle of `\\u4f60`, `\\u597d`, and the surrogate pair `\\ud83d\\ude42`; target streams use native Chat `tool_calls` deltas and Messages `input_json_delta` frames.
- JSON acceptance requires the SDK-consumed Responses output item to be `custom_tool_call` with the original name/call ID and unwrapped **string** `input`. The ordinary function control requires `function_call` and JSON arguments whose parsed `input` equals the same Unicode text. This compares the semantic JSON value because Messages may reserialize equivalent Unicode escapes.
- SSE acceptance requires `response.output_item.added` and `.done` for a custom item, `response.custom_tool_call_input.delta`/`.done` with stable `item_id` and `output_index`, concatenated deltas and done input equal to the original string, and `response.completed.response.output` containing that closed custom item. The separate same-name function stream must have no custom input events. Both target paths and upstream request projection are asserted.
- The expanded fixture requires Chat Completions ordinary function JSON and SSE terminal output items to have `status: "completed"`. Its ninth request is a Messages custom SSE stream whose `tool_use` starts and receives an incomplete JSON delta but never gets `content_block_stop`. It must make exactly one upstream request, surface an SDK error or failure event, and never emit `response.completed`.

## Observed results

| Target | Custom JSON | Same-name function JSON | Custom SSE | Same-name function SSE |
| --- | --- | --- | --- | --- |
| Chat Completions | Baseline: 400 before upstream; final: `custom_tool_call` JSON | Final: `function_call` with completed status | Baseline: 400 before upstream; final: custom input delta/done and completed custom output | Final: function stream with completed terminal status and no custom input events |
| Messages | Baseline: 400 before upstream; final: `custom_tool_call` JSON | Final: `function_call` | Baseline: 400 before upstream; final: custom input delta/done and completed custom output | Final: function stream with no custom input events |

The historical eight-case green run captured four `/v1/chat/completions` and four `/v1/messages` upstream requests. Its custom SSE cases emitted `response.custom_tool_call_input.delta` and `.done`, used stable item IDs and output indices, and had matching closed custom items in `response.completed.response.output`; same-name function streams emitted no custom input events.

The expanded nine-case pre-repair run made nine upstream requests and failed three assertions: Chat JSON and SSE ordinary function items lacked `status: "completed"`, while the malformed Messages custom stream incorrectly emitted `response.completed` after only `response.output_item.added`. The first repair's nine-case run also made nine upstream requests. Chat SSE terminal status and malformed-stream error handling passed; Chat JSON ordinary function terminal status remained the one failing assertion.

The final run made nine upstream requests and passed all nine cases. The Chat JSON ordinary function output item and Chat SSE `.done`/`response.completed` ordinary function items each have `status: "completed"`. The malformed Messages stream emitted `response.created`, `response.in_progress`, `response.output_item.added`, then `error`, with no `response.completed`. The fixture verifies SDK-consumed JSON and SSE outputs and the actual gateway translation route. It does not show static SDK schema validation, behavior from a hosted OpenAI/Anthropic endpoint, a separate gateway HTTP socket, or behavior of the A06 delta after commit/review.

## Controller completion evidence

Both scoped fix reviews approved the final source. Final clean `bun run ci:local` exited 0: 4107 passed, one skipped, zero failed; all workspace types, purity, lint (36 inherited warnings), UI build and Workers dry-run passed. The 14 source/test files match the independently verified source exactly.

The executed fixture is archived as [run.ts.txt](run.ts.txt). Copy it into a disposable directory as `run.ts`, adjust the installed SDK import/source root if needed, then run with Bun. It allocates a fresh run directory and synthetic SQLite database and stops its own loopback upstream. [Original rejection baseline](results-red.json), [negative stream red](results-negative-red.json), and [final nine-case acceptance](results-final.json) are retained. This is synthetic in-process gateway acceptance, not live-provider or production transport validation.
