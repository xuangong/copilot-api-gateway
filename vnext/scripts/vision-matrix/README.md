# Vision matrix

Does an image survive every client protocol the gateway accepts?

Each cell sends one freshly generated 2×2 colour grid and asks the model to
read it back clockwise. A translator that drops, reshapes or reorders an image
block shows up as a wrong answer; a model that never saw the image cannot guess
its way to a pass (four distinct colours out of eight ≈ 1 in 1680).

The grid is minted per run from a seeded RNG, so nothing can be memorised — and
a failure is reproducible with `--seed`.

## Why it exists

`chat-completions-via-responses` and `messages-via-responses` used to emit

```json
{ "type": "input_image", "text": "data:image/png;base64,..." }
```

instead of the `image_url` the Responses API (and this repo's own schema in
`protocols-llm/src/responses/index.ts`) requires. Upstreams answered with
`400 image_url is required for content type image_url`. The unit tests agreed
with the bug, because they had been written from the implementation. Only an
end-to-end probe caught it.

## Usage

```bash
# a couple of models across all four client protocols
bun scripts/vision-matrix --key sk_... --models gpt-5.6-sol,claude-opus-5

# everything the gateway serves
bun scripts/vision-matrix --key sk_... --all

# one protocol only
bun scripts/vision-matrix --key sk_... --all --protocols responses

# reproduce a failure
bun scripts/vision-matrix --key sk_... --models grok-4.6 --seed 36317
```

| flag | default | meaning |
|---|---|---|
| `--key` | `$GATEWAY_KEY` | gateway API key (required) |
| `--base` | `$GATEWAY_URL`, else `http://localhost:41414` | gateway base URL |
| `--models` | — | comma-separated model ids |
| `--all` | off | every model from `GET /v1/models` |
| `--protocols` | all four | `openai,anthropic,gemini,responses` |
| `--seed` | time-derived | fixes the colour grids |
| `--timeout` | `90000` | per-request ms; a stream that never closes would otherwise hang the run |

Exit code is non-zero when a cell fails, so it can gate a release.

## Capability audit

```bash
bun scripts/vision-matrix --key sk_... --capabilities
```

Cross-checks each model's advertised `capabilities.supports.vision` against
what it actually does. **The two disagree**, so the flag can't be trusted on
its own to gate a UI. As of 2026-08-22, against a Copilot upstream (26 chat
models):

| | count | models |
|---|---|---|
| flag matches reality | 20 | everything from roughly the last two years |
| flag says no, vision works | 4 | `gpt-4`, `gpt-4-0613`, `gpt-4-0125-preview`, `gpt-4-o-preview` |
| flag says yes, upstream 400s | 1 | `gpt-4o` |

Re-run the audit before relying on the flag; the catalogue changes.

## Reading the results

| mark | meaning |
|---|---|
| `PASS` | four colours, right order — the image arrived intact |
| `WRONG` | the model answered but misread the grid. It *did* receive an image; small models routinely confuse clockwise ordering |
| `REJECT` | upstream refused the image (no vision on that deployment) |
| `ERR` | transport failure, timeout, or a non-image 400 |

`WRONG` is not a translator bug on its own. Check whether the same model passes
on another protocol before investigating — if it passes anywhere, the image
pipeline is fine and the model is just inaccurate.

## Layout

- `png.ts` — minimal truecolour PNG encoder, so fixtures need no browser and no
  checked-in binaries. IDAT must be a zlib stream, not raw deflate; lenient
  decoders accept the latter but upstream validators do not.
- `probe.ts` — per-protocol request shaping, SSE delta readers, grading.
- `index.ts` — the runner.
- `*.test.ts` — cover the parts that rot silently: the image block shape per
  protocol and the delta readers.
