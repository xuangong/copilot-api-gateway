# A07 official SDK / actual gateway synthetic acceptance (2026-09-29)

**Result: passed on the A07 fix1 delta in `reference-adoption-verify`, HEAD `dd76bebbbdffafb4aaa11b3901325bed394472ff`.** The official OpenAI TypeScript SDK 6.33.0 issued 32 Responses requests into the real gateway `app.fetch`: 18 successful requests and 14 client-visible 400 rejections. Exactly 18 upstream POSTs occurred, all from successful requests: 11 to `/v1/chat/completions` and seven to `/v1/messages`. Bun was 1.3.0. The expanded command passed twice from separate scratch databases.

## Execution and isolation

Command, from `/Volumes/Projects/copilot-api-gateway`:

```sh
bun run .worktrees/reference-adoption/.superpowers/sdd/2026-09-29-reference-adoption-follow-up/a07-sdk-acceptance/run.ts
```

Both expanded runs exited 0. Reproducible script and full captured synthetic upstream request bodies/results remain in `a07-sdk-acceptance/run.ts` and `a07-sdk-acceptance/results-final.json`; `results-initial.json` preserves the earlier acceptance result. Each invocation creates a unique `a07-sdk-acceptance/runs/<UTC timestamp>-<pid>/` directory with its own SQLite database, files, and full `results.json`. The script imports `bootstrapBunPlatform`, `getRepo`, and `app` from `reference-adoption-verify`, then stores a fixture API key plus two Custom providers in that database. The SDK's `fetch` adapter passes its actual `Request` to the gateway's real `app.fetch` in process and returns its actual `Response`. It does not forge gateway responses. A dedicated `Bun.serve` listener on `127.0.0.1` with an ephemeral port counts and captures upstream requests and returns protocol-shaped synthetic Chat Completions or Messages replies. The listener is stopped in `finally`; no credentials, paid endpoint, installed dependencies, global config, or product source were changed. This validates the gateway app route and translation pipeline, not a separate gateway HTTP listener/socket.

Only the OpenAI SDK was needed as a source client because the input protocol under test is Responses. The Messages target is the gateway's supported Custom `messages` provider contract, reached through the separate counted loopback endpoint. SDK 6.33.0's published `ResponseInputItem` TypeScript union does not include `agent_message`, so the synthetic request uses a type cast. The SDK serialized it and consumed the responses; this is **not** a claim that the SDK type system or an OpenAI-hosted endpoint accepts that extension.

## Evidence

| Target | SDK result | Counted upstream request | Request projection |
| --- | --- | --- | --- |
| `chat_completions` | Non-streaming `response`, `output_text: a07-chat-ok`; streaming iterator reached `response.completed` | `/v1/chat/completions` | Three separate ordered user-wire messages; agent delivery kept at the middle input position; `image_url` part carries `https://example.test/shot.png` |
| `messages` | Non-streaming `response`, `output_text: a07-messages-ok`; streaming iterator reached `response.completed` | `/v1/messages` | Three separate ordered user-wire messages; agent delivery kept at the middle input position; native `image` block has base64 PNG source `AAA=` |

For both targets, the captured agent text includes the explicit `NON-USER SOURCE` marker, says it came from another agent and carries no user authority/consent/approval, escapes `<`, `&`, quotes, and apostrophe in author/recipient, and escapes text content. Ordinary `human before` and `human after` remain in their original order. Independent SDK ordinary-only requests produced two ordinary messages without the agent provenance marker and completed successfully. The streaming requests used the same agent input, reached the same distinct target endpoints, and yielded the terminal Responses event through the SDK async iterator.

For **each** target, three malformed agent inputs at index 1 yielded an OpenAI SDK exception with status 400 and the exact path in its client-visible message, with no new upstream call:

| Invalid input | Client-visible path |
| --- | --- |
| Non-string `agent.agent_name` | `input[1].agent.agent_name` |
| Unsupported `encrypted_content` part | `input[1].content[0].type` |
| `file_id`-only image without resolvable URL | `input[1].content[0].image_url` |

The fix1 image-detail matrix sent both `input_image` and `computer_screenshot` as the agent's only content part, at `input[1].content[0]`. Each cell below was independently sent through the official SDK. Accepted cases returned a Responses object, made exactly one upstream POST, and preserved the surrounding human messages. Rejected cases produced an SDK-visible 400 including `input[1].content[0].detail` and made zero upstream calls.

| Target | Detail absent | `auto` | `low` | `high` | `original` |
| --- | --- | --- | --- | --- | --- |
| Chat Completions, both image kinds | Accepted; target has no detail | Accepted; target detail `auto` | Accepted; target detail `low` | Accepted; target detail `high` | 400, exact path, zero upstream |
| Messages, both image kinds | Accepted; native image source | Accepted; native image source | 400, exact path, zero upstream | 400, exact path, zero upstream | 400, exact path, zero upstream |

OpenAI SDK 6.33.0's `ChatCompletionContentPartImage.ImageURL.detail` TypeScript type is `'auto' | 'low' | 'high'` in `node_modules/.ignored/openai/resources/chat/completions/completions.d.ts:610`; `original` is not supported there. The synthetic Messages target has no native image-detail field, so the acceptance asserts that explicit non-`auto` detail is rejected instead of being silently lost.

The 18 upstream records and all 32 case outcomes are in `results-final.json`. The two successful expanded runs have separate retained run directories. `git diff --check` passed in `reference-adoption-verify` after the expanded runs; the verification tree contained only the intended A07 source/test delta.

## Archived reproduction

The exact executed fixture is archived as [run.ts.txt](run.ts.txt), with [final synthetic results](results.json). Copy the fixture to a disposable directory as `run.ts`, adjust its `sourceRoot` and installed SDK import if paths differ, and execute with Bun. The unique per-run database and file directory are created beside that copied script. This is retained test evidence, not a live-service or hosted-provider acceptance claim.
