# Spec 12a — Data-Plane Parity Report

**Generated:** 2026-06-25T12:50:13.399Z
**Fixtures:** 27

## Summary

| label | count |
|-------|-------|
| parity | 27 |
| cosmetic-diff | 0 |
| behavior-gap | 0 |
| route-missing | 0 |

## Per-fixture

| endpoint | fixture | label | root | vnext | summary |
|----------|---------|-------|------|-------|---------|
| `/chat/completions` | alias-e1-chat-completions | **parity** | 200 | 200 | — |
| `/responses` | alias-e2-responses | **parity** | 200 | 200 | — |
| `/embeddings` | alias-e3-embeddings | **parity** | 200 | 200 | — |
| `/images/generations` | alias-e4-images-generations | **parity** | 404 | 404 | — |
| `/images/edits` | alias-e5-images-edits | **parity** | 404 | 404 | — |
| `/v1/chat/completions` | chat-completions-basic-non-stream | **parity** | 200 | 200 | — |
| `/v1/chat/completions` | chat-completions-stream-include-usage | **parity** | 200 | 200 | — |
| `/v1/chat/completions` | chat-completions-tool-required | **parity** | 200 | 200 | — |
| `/v1/embeddings` | embeddings-array-three | **parity** | 200 | 200 | — |
| `/v1/embeddings` | embeddings-bad-model-4xx | **parity** | 404 | 404 | — |
| `/v1/embeddings` | embeddings-single-string | **parity** | 200 | 200 | — |
| `/v1beta/models/gemini-2.5-flash:countTokens` | gemini-count-tokens | **parity** | 200 | 200 | — |
| `/v1beta/models/gemini-2.5-flash:generateContent` | gemini-generate-content | **parity** | 200 | 200 | — |
| `/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse` | gemini-stream-generate-content | **parity** | 200 | 200 | — |
| `/v1beta/models/gemini-2.5-flash:generateContent` | gemini-tool-call | **parity** | 200 | 200 | — |
| `/v1/images/generations` | images-bad-size-4xx | **parity** | 404 | 404 | — |
| `/v1/images/edits` | images-edits-png | **parity** | 404 | 404 | — |
| `/v1/images/generations` | images-generations-basic | **parity** | 404 | 404 | — |
| `/v1/messages` | messages-basic-non-stream | **parity** | 404 | 404 | — |
| `/v1/messages/count_tokens` | messages-count-tokens | **parity** | 404 | 404 | — |
| `/v1/messages` | messages-stream | **parity** | 404 | 404 | — |
| `/api/models` | models-api | **parity** | 200 | 200 | — |
| `/models` | models-root | **parity** | 200 | 200 | — |
| `/v1/models` | models-v1 | **parity** | 200 | 200 | — |
| `/v1/responses` | responses-basic-non-stream | **parity** | 200 | 200 | — |
| `/v1/responses` | responses-stream | **parity** | 200 | 200 | — |
| `/v1/responses` | responses-stateful-chain | **parity** | 400 | 400 | — |

## Appendix — full diffs

### alias-e1-chat-completions (`/chat/completions`) — parity

No diffs.

### alias-e2-responses (`/responses`) — parity

No diffs.

### alias-e3-embeddings (`/embeddings`) — parity

No diffs.

### alias-e4-images-generations (`/images/generations`) — parity

No diffs.

### alias-e5-images-edits (`/images/edits`) — parity

No diffs.

### chat-completions-basic-non-stream (`/v1/chat/completions`) — parity

No diffs.

### chat-completions-stream-include-usage (`/v1/chat/completions`) — parity

No diffs.

### chat-completions-tool-required (`/v1/chat/completions`) — parity

No diffs.

### embeddings-array-three (`/v1/embeddings`) — parity

No diffs.

### embeddings-bad-model-4xx (`/v1/embeddings`) — parity

No diffs.

### embeddings-single-string (`/v1/embeddings`) — parity

No diffs.

### gemini-count-tokens (`/v1beta/models/gemini-2.5-flash:countTokens`) — parity

No diffs.

### gemini-generate-content (`/v1beta/models/gemini-2.5-flash:generateContent`) — parity

No diffs.

### gemini-stream-generate-content (`/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`) — parity

No diffs.

### gemini-tool-call (`/v1beta/models/gemini-2.5-flash:generateContent`) — parity

No diffs.

### images-bad-size-4xx (`/v1/images/generations`) — parity

No diffs.

### images-edits-png (`/v1/images/edits`) — parity

No diffs.

### images-generations-basic (`/v1/images/generations`) — parity

No diffs.

### messages-basic-non-stream (`/v1/messages`) — parity

No diffs.

### messages-count-tokens (`/v1/messages/count_tokens`) — parity

No diffs.

### messages-stream (`/v1/messages`) — parity

No diffs.

### models-api (`/api/models`) — parity

No diffs.

### models-root (`/models`) — parity

No diffs.

### models-v1 (`/v1/models`) — parity

No diffs.

### responses-basic-non-stream (`/v1/responses`) — parity

No diffs.

### responses-stream (`/v1/responses`) — parity

No diffs.

### responses-stateful-chain (`/v1/responses`) — parity

No diffs.
