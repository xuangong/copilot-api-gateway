# Spec 12a — Data-Plane Parity Report

**Generated:** 2026-06-25T09:08:26.827Z
**Fixtures:** 27

## Summary

| label | count |
|-------|-------|
| parity | 0 |
| cosmetic-diff | 0 |
| behavior-gap | 27 |
| route-missing | 0 |

## Per-fixture

| endpoint | fixture | label | root | vnext | summary |
|----------|---------|-------|------|-------|---------|
| `/chat/completions` | alias-e1-chat-completions | **behavior-gap** | 401 | 404 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/responses` | alias-e2-responses | **behavior-gap** | 401 | 404 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/embeddings` | alias-e3-embeddings | **behavior-gap** | 401 | 200 | status:behavior-gap / body:behavior-gap / body:behavior-gap |
| `/images/generations` | alias-e4-images-generations | **behavior-gap** | 401 | 404 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/images/edits` | alias-e5-images-edits | **behavior-gap** | 401 | 404 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/v1/chat/completions` | chat-completions-basic-non-stream | **behavior-gap** | 401 | 200 | status:behavior-gap / body:behavior-gap / body:behavior-gap |
| `/v1/chat/completions` | chat-completions-stream-include-usage | **behavior-gap** | 401 | 200 | status:behavior-gap / header:cosmetic-diff / header:cosmetic-diff |
| `/v1/chat/completions` | chat-completions-tool-required | **behavior-gap** | 401 | 200 | status:behavior-gap / body:behavior-gap / body:behavior-gap |
| `/v1/embeddings` | embeddings-array-three | **behavior-gap** | 401 | 200 | status:behavior-gap / body:behavior-gap / body:behavior-gap |
| `/v1/embeddings` | embeddings-bad-model-4xx | **behavior-gap** | 401 | 404 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/v1/embeddings` | embeddings-single-string | **behavior-gap** | 401 | 200 | status:behavior-gap / body:behavior-gap / body:behavior-gap |
| `/v1beta/models/gemini-2.5-flash:countTokens` | gemini-count-tokens | **behavior-gap** | 401 | 404 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/v1beta/models/gemini-2.5-flash:generateContent` | gemini-generate-content | **behavior-gap** | 401 | 404 | status:behavior-gap / body:behavior-gap |
| `/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse` | gemini-stream-generate-content | **behavior-gap** | 401 | 404 | status:behavior-gap |
| `/v1beta/models/gemini-2.5-flash:generateContent` | gemini-tool-call | **behavior-gap** | 401 | 404 | status:behavior-gap / body:behavior-gap |
| `/v1/images/generations` | images-bad-size-4xx | **behavior-gap** | 401 | 404 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/v1/images/edits` | images-edits-png | **behavior-gap** | 401 | 404 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/v1/images/generations` | images-generations-basic | **behavior-gap** | 401 | 404 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/v1/messages` | messages-basic-non-stream | **behavior-gap** | 401 | 200 | status:behavior-gap / body:behavior-gap / body:behavior-gap |
| `/v1/messages/count_tokens` | messages-count-tokens | **behavior-gap** | 401 | 200 | status:behavior-gap / body:behavior-gap / body:behavior-gap |
| `/v1/messages` | messages-stream | **behavior-gap** | 401 | 200 | status:behavior-gap / header:cosmetic-diff / header:cosmetic-diff |
| `/api/models` | models-api | **behavior-gap** | 401 | 200 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/models` | models-root | **behavior-gap** | 401 | 200 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/v1/models` | models-v1 | **behavior-gap** | 401 | 200 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/v1/responses` | responses-basic-non-stream | **behavior-gap** | 401 | 400 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |
| `/v1/responses` | responses-stream | **behavior-gap** | 401 | 400 | status:behavior-gap / header:cosmetic-diff |
| `/v1/responses` | responses-stateful-chain | **behavior-gap** | 401 | 400 | status:behavior-gap / header:cosmetic-diff / body:behavior-gap |

## Appendix — full diffs

### alias-e1-chat-completions (`/chat/completions`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="text/plain; charset=UTF-<num>"
- **body** [behavior-gap] $: type root=object vnext=string

### alias-e2-responses (`/responses`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="text/plain; charset=UTF-<num>"
- **body** [behavior-gap] $: type root=object vnext=string

### alias-e3-embeddings (`/embeddings`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **body** [behavior-gap] $.error: type root=string vnext=undefined
- **body** [behavior-gap] $.data: type root=undefined vnext=object
- **body** [behavior-gap] usage keys: onlyRoot=[] onlyVnext=[prompt_tokens,total_tokens]

### alias-e4-images-generations (`/images/generations`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=object

### alias-e5-images-edits (`/images/edits`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=object

### chat-completions-basic-non-stream (`/v1/chat/completions`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **body** [behavior-gap] $.error: type root=string vnext=undefined
- **body** [behavior-gap] $.object: type root=undefined vnext=string
- **body** [behavior-gap] $.model: type root=undefined vnext=string
- **body** [behavior-gap] $.choices: type root=undefined vnext=object
- **body** [behavior-gap] usage keys: onlyRoot=[] onlyVnext=[completion_tokens,completion_tokens_details,prompt_tokens,prompt_tokens_details,total_tokens,reasoning_tokens]

### chat-completions-stream-include-usage (`/v1/chat/completions`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="text/event-stream"
- **header** [cosmetic-diff] transfer-encoding: root=<absent> vnext=chunked
- **header** [cosmetic-diff] cache-control: root=<absent> vnext=no-cache
- **sse** [behavior-gap] event count root=1 vnext=4

### chat-completions-tool-required (`/v1/chat/completions`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **body** [behavior-gap] $.error: type root=string vnext=undefined
- **body** [behavior-gap] $.object: type root=undefined vnext=string
- **body** [behavior-gap] $.model: type root=undefined vnext=string
- **body** [behavior-gap] $.choices: type root=undefined vnext=object
- **body** [behavior-gap] usage keys: onlyRoot=[] onlyVnext=[completion_tokens,completion_tokens_details,prompt_tokens,prompt_tokens_details,total_tokens,reasoning_tokens]

### embeddings-array-three (`/v1/embeddings`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **body** [behavior-gap] $.error: type root=string vnext=undefined
- **body** [behavior-gap] $.data: type root=undefined vnext=object
- **body** [behavior-gap] usage keys: onlyRoot=[] onlyVnext=[prompt_tokens,total_tokens]

### embeddings-bad-model-4xx (`/v1/embeddings`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=object

### embeddings-single-string (`/v1/embeddings`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **body** [behavior-gap] $.error: type root=string vnext=undefined
- **body** [behavior-gap] $.data: type root=undefined vnext=object
- **body** [behavior-gap] usage keys: onlyRoot=[] onlyVnext=[prompt_tokens,total_tokens]

### gemini-count-tokens (`/v1beta/models/gemini-2.5-flash:countTokens`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=object

### gemini-generate-content (`/v1beta/models/gemini-2.5-flash:generateContent`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404
- **body** [behavior-gap] $.error: type root=string vnext=object

### gemini-stream-generate-content (`/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404

### gemini-tool-call (`/v1beta/models/gemini-2.5-flash:generateContent`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404
- **body** [behavior-gap] $.error: type root=string vnext=object

### images-bad-size-4xx (`/v1/images/generations`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=object

### images-edits-png (`/v1/images/edits`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=object

### images-generations-basic (`/v1/images/generations`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=404
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=object

### messages-basic-non-stream (`/v1/messages`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **body** [behavior-gap] $.error: type root=string vnext=undefined
- **body** [behavior-gap] $.type: type root=undefined vnext=string
- **body** [behavior-gap] $.role: type root=undefined vnext=string
- **body** [behavior-gap] $.model: type root=undefined vnext=string
- **body** [behavior-gap] $.content: non-empty root=false vnext=true
- **body** [behavior-gap] $.stop_reason: type root=undefined vnext=string
- **body** [behavior-gap] $.stop_sequence: type root=undefined vnext=object
- **body** [behavior-gap] usage keys: onlyRoot=[] onlyVnext=[input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens]

### messages-count-tokens (`/v1/messages/count_tokens`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **body** [behavior-gap] $.error: type root=string vnext=undefined
- **body** [behavior-gap] $.input_tokens: type root=undefined vnext=number

### messages-stream (`/v1/messages`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="text/event-stream"
- **header** [cosmetic-diff] transfer-encoding: root=<absent> vnext=chunked
- **header** [cosmetic-diff] cache-control: root=<absent> vnext=no-cache
- **sse** [behavior-gap] event count root=1 vnext=6

### models-api (`/api/models`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=undefined
- **body** [behavior-gap] $.object: type root=undefined vnext=string
- **body** [behavior-gap] $.data: type root=undefined vnext=object

### models-root (`/models`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=undefined
- **body** [behavior-gap] $.object: type root=undefined vnext=string
- **body** [behavior-gap] $.data: type root=undefined vnext=object

### models-v1 (`/v1/models`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=200
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=undefined
- **body** [behavior-gap] $.object: type root=undefined vnext=string
- **body** [behavior-gap] $.data: type root=undefined vnext=object

### responses-basic-non-stream (`/v1/responses`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=400
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=object

### responses-stream (`/v1/responses`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=400
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"

### responses-stateful-chain (`/v1/responses`) — behavior-gap

- **status** [behavior-gap] root=401 vnext=400
- **header** [cosmetic-diff] content-type: root="application/json;charset=utf-<num>" vnext="application/json"
- **body** [behavior-gap] $.error: type root=string vnext=object
