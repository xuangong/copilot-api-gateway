# C06 progressive observed usage evidence

Validated on 2026-09-29 against the clean verification worktree at `3fc5a548` plus only the reviewed C06 patch. The official Anthropic SDK version was `0.80.0`, installed in `/tmp/vnext-reference-sdk-probe/node_modules` from prior work. No network, credentials, model request, dependency installation or service was used.

The [synthetic fetch probe](c06-sdk-probe.ts.txt) imports the actual translator and records SDK stream-event snapshots and `finalMessage()` in [the output](c06-sdk-output.json). To reproduce in this workspace, copy the probe to `/tmp/c06-clean-sdk-probe.ts` and run `bun /tmp/c06-clean-sdk-probe.ts`; adjust the explicit checkout/SDK paths if those trees move.

The input sequence contains prompt usage first, text with one output token, a finish chunk, and trailing output/cache usage. The SDK observed intermediate usage and returned text `hi` with final uncached input 7, output 2 and cache-read input 3. A root assertion verified those final values after the clean-source run. Input-only progressive events intentionally omit unobserved output; SDK snapshots can temporarily have no output count until one is observed. This probe does not establish live-provider continuous-usage support.

Focused tests also cover role-only startup delay, immediate content without usage, explicit empty refusal, sparse/repeated/zero samples, errors, missing terminal, cancellation, Gemini composition, and Messages JSON reassembly of late input/cache counters. No unsupported `continuous_usage_stats` extension is forced on requests.
