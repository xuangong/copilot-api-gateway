# Data-Plane Parity Fixtures (Spec 12a §4)

27 fixtures across 8 family rows:

| family | count | notes |
|--------|-------|-------|
| chat-completions | 3 | basic / stream+include_usage / tool_choice=required |
| messages | 3 | basic / stream / count_tokens |
| responses | 3 | basic / stream / stateful (uses ${PREV_RESPONSE_ID}) |
| gemini | 4 | generateContent / streamGenerateContent / tool / countTokens |
| embeddings | 3 | single / array / bad-model-4xx |
| images | 3 | generations / edits (multipart) / bad-size-4xx |
| models | 3 | /v1/models / /models / /api/models (GET) |
| alias-only | 5 | non-v1 paths: e1-e5 |
| **total** | **27** | |

## Conventions

- `${API_KEY}` substituted at load time from `PARITY_API_KEY` env
- `${PREV_RESPONSE_ID}` substituted by Part 3 runner after responses-basic returns
- `multipart: true` flag inside body switches the runner to multipart encoding
- `expect_stream: true` triggers SSE diff path; otherwise JSON deep-diff

Add new fixtures by dropping a new `.json` file here — loader picks them up by
directory scan in alphabetical order.
