# Responses text-format SDK acceptance

Date: 2026-09-29 (Asia/Shanghai). The installed official OpenAI SDK 6.33.0 calls the real vNext `app.fetch`; isolated SQLite and a counted ephemeral loopback server supply synthetic Custom Chat Completions and Messages targets. No hosted requests, dependency installation, or product data are involved.

| Run | Verify HEAD and working delta | Cases | Passed | Failed | Upstream calls |
| --- | --- | ---: | ---: | ---: | ---: |
| Baseline | `4449d6a2c05e09d90eb14c45f8f4cb9143e0f1c8` + D05 UI-only changes | 122 | 12 | 110 | 122 |
| Final | `9ce5c76e98b8e1d263563243e29a5e4ca0caff3b` + frozen 15-file A15 implementation | 122 | 122 | 0 | 32 |

The exact same harness ran both times. Twelve absent/empty-text/explicit-text controls pass. Twenty structured-output cases verify exact outbound native format, preserved source format echo, JSON/SSE terminal text, and completed status. Ninety malformed, unsupported, or conflicting cases require HTTP/SDK 400 with the precise source field path and zero upstream calls. The final run meets all assertions. Source status and the recorded translator/traversal hashes are stable before/after each run.

Coverage includes Chat `json_object`; Chat schemas with strict absent/false/true and description absent/present; Messages strict-true schema without description, reasoning-derived effort, and existing `output_config.effort`. Messages preserves schema on the target while source echo retains name metadata. Both JSON and SSE exercise shape errors, field types, name validation, unsupported Messages constraints, and native-format conflicts.

- [Baseline results](./baseline-results.json) retain the pre-fix failures and full SDK/outbound observations.
- [Final results](./final-results.json) retain the complete passing observations and source metadata.
- [Harness](./harness.txt) is stored as text to avoid test discovery. To rerun locally, save as `run.ts` and adjust the absolute SDK and source paths. It creates timestamped run directories and isolated fixtures next to itself, then shuts down its loopback listener.
- [SHA-256 manifest](./evidence-sha256.json) identifies these evidence bytes.

Limitations: synthetic responses prove projection, pre-egress validation, and SDK wire consumption; they do not prove hosted-model schema support or generation enforcement. The harness exercises ordinary Custom routes, not DeepSeek/Copilot normalizer gates. Those gates require separate implementation tests. Baseline/final HEAD values identify verify base commits; the recorded dirty deltas are part of each tested source state. This acceptance does not replace full CI or code review.
