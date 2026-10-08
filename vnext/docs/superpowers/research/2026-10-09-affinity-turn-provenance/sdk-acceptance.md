# Affinity SDK acceptance evidence

This script exercises real gateway serve functions, in-memory SQLite persistence,
loopback synthetic upstreams, and already installed official SDKs. It neither
installs dependencies nor uses production credentials or services.

Copy [sdk-acceptance.ts.txt](sdk-acceptance.ts.txt) to `acceptance.ts` inside a fresh ignored evidence directory. Run with explicit package directories (each containing `index.mjs` and `package.json`):

```sh
AFFINITY_GATEWAY_CHECKOUT=/absolute/path/to/copilot-api-gateway \
AFFINITY_OPENAI_SDK=/absolute/path/to/installed/openai \
AFFINITY_ANTHROPIC_SDK=/absolute/path/to/installed/anthropic-sdk \
bun /absolute/path/to/acceptance.ts
```

The output directory is the directory containing the script. [`sdk-results.json`](sdk-results.json) records the retained run; each fresh `summary.json`
records package versions, collector source hashes, and measured boundaries. All
wire payloads and keys in these artifacts are synthetic fixture data.

Verified with OpenAI 6.33.0 and Anthropic 0.80.0:

- Responses SDK intermediate text/tool snapshots use the correct shifted indices;
  final JSON and replay preserve both origin and natural state. A separate strict
  wire accumulator verifies empty `created.output`, later lifecycle snapshots,
  contiguous added/done indices, content deltas, sequence numbers, and terminal
  equality. The separate check is necessary because OpenAI 6.33.0 ignores
  `response.in_progress` and `response.output_item.done` in its own reducer.
- Anthropic `finalMessage()` retains redacted origin, signed native thinking,
  complete text, and tool arguments. JSON history replay strips gateway carriers
  and restores the exact natural signature and thinking bytes.
- OpenAI Chat `finalChatCompletion()` retains `reasoning_opaque` in ordinary-text
  and modern `tool_calls` replies; JSON replay preserves text/tools and removes
  the carrier before inference.
- OpenAI 6.33.0's deprecated `function_call` finalizer drops extension fields,
  including `reasoning_opaque`. The raw chunk callback still receives the origin.
  This is an observed client collector limitation, not a gateway wire omission.

This is local Bun/SDK correctness evidence, not Cloudflare resource measurement
or validation of SDK versions other than those recorded in `summary.json`.
