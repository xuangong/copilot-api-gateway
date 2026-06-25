# Spec 12a — Data-Plane Parity Report

**Generated:** 2026-06-25T12:19:28.809Z
**Fixtures:** 27

## Summary

| label | count |
|-------|-------|
| parity | 20 |
| cosmetic-diff | 0 |
| behavior-gap | 7 |
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
| `/v1/chat/completions` | chat-completions-stream-include-usage | **behavior-gap** | 200 | 200 | sse:behavior-gap |
| `/v1/chat/completions` | chat-completions-tool-required | **parity** | 200 | 200 | — |
| `/v1/embeddings` | embeddings-array-three | **parity** | 200 | 200 | — |
| `/v1/embeddings` | embeddings-bad-model-4xx | **parity** | 404 | 404 | — |
| `/v1/embeddings` | embeddings-single-string | **parity** | 200 | 200 | — |
| `/v1beta/models/gemini-2.5-flash:countTokens` | gemini-count-tokens | **behavior-gap** | 200 | 200 | body:behavior-gap |
| `/v1beta/models/gemini-2.5-flash:generateContent` | gemini-generate-content | **parity** | 200 | 200 | — |
| `/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse` | gemini-stream-generate-content | **parity** | 200 | 200 | — |
| `/v1beta/models/gemini-2.5-flash:generateContent` | gemini-tool-call | **parity** | 200 | 200 | — |
| `/v1/images/generations` | images-bad-size-4xx | **parity** | 404 | 404 | — |
| `/v1/images/edits` | images-edits-png | **parity** | 404 | 404 | — |
| `/v1/images/generations` | images-generations-basic | **parity** | 404 | 404 | — |
| `/v1/messages` | messages-basic-non-stream | **behavior-gap** | 404 | 404 | body:behavior-gap / body:behavior-gap |
| `/v1/messages/count_tokens` | messages-count-tokens | **parity** | 404 | 404 | — |
| `/v1/messages` | messages-stream | **parity** | 404 | 404 | — |
| `/api/models` | models-api | **behavior-gap** | 200 | 200 | body:behavior-gap |
| `/models` | models-root | **behavior-gap** | 200 | 200 | body:behavior-gap |
| `/v1/models` | models-v1 | **behavior-gap** | 200 | 200 | body:behavior-gap |
| `/v1/responses` | responses-basic-non-stream | **parity** | 200 | 200 | — |
| `/v1/responses` | responses-stream | **behavior-gap** | 200 | 200 | sse:behavior-gap |
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

### chat-completions-stream-include-usage (`/v1/chat/completions`) — behavior-gap

- **sse** [behavior-gap] event count root=5 vnext=4

### chat-completions-tool-required (`/v1/chat/completions`) — parity

No diffs.

### embeddings-array-three (`/v1/embeddings`) — parity

No diffs.

### embeddings-bad-model-4xx (`/v1/embeddings`) — parity

No diffs.

### embeddings-single-string (`/v1/embeddings`) — parity

No diffs.

### gemini-count-tokens (`/v1beta/models/gemini-2.5-flash:countTokens`) — behavior-gap

- **body** [behavior-gap] $.totalTokens: root=24 vnext=51

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

### messages-basic-non-stream (`/v1/messages`) — behavior-gap

- **body** [behavior-gap] $.error.type: root="invalid_request_error" vnext="api_error"
- **body** [behavior-gap] $.error.message: root="No messages upstream available for model: claude-haiku-4-5. Run GET /v1/models for available ids." vnext="model not found: claude-haiku-4-5"

### messages-count-tokens (`/v1/messages/count_tokens`) — parity

No diffs.

### messages-stream (`/v1/messages`) — parity

No diffs.

### models-api (`/api/models`) — behavior-gap

- **body** [behavior-gap] $.data: array len root=29 vnext=30

### models-root (`/models`) — behavior-gap

- **body** [behavior-gap] $.data: array len root=29 vnext=30

### models-v1 (`/v1/models`) — behavior-gap

- **body** [behavior-gap] $.data: array len root=29 vnext=30

### responses-basic-non-stream (`/v1/responses`) — parity

No diffs.

### responses-stream (`/v1/responses`) — behavior-gap

- **sse** [behavior-gap] event count root=9 vnext=5

### responses-stateful-chain (`/v1/responses`) — parity

No diffs.
