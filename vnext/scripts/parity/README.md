# Data-Plane Parity Harness (Spec 12a)

Compares root `src/` (port 4141) and vnext (port 41415) on the 27-fixture suite
defined in `vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md`.

## Run

```bash
# Prerequisite: start both servers (see spec §2)
PORT=4141 bun run local                                                    # repo root, one shell
docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d     # another shell

# Run audit
PARITY_API_KEY=<gh-token> bun run vnext/scripts/parity/data-plane-audit.ts
```

## Env

| var | default | purpose |
|-----|---------|---------|
| `PARITY_API_KEY` | (empty) | Substituted into fixture headers; must work against BOTH servers |
| `PARITY_ROOT_BASE` | `http://127.0.0.1:4141` | Root server base URL |
| `PARITY_VNEXT_BASE` | `http://127.0.0.1:41415` | vNext server base URL |
| `PARITY_REPORT_PATH` | `vnext/docs/superpowers/research/2026-06-25-spec12a-parity-report.md` | Output report |

## Fixture format

```json
{
  "name": "chat-completions-basic-non-stream",
  "endpoint": "/v1/chat/completions",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}" },
  "body": { "model": "gpt-4o-mini", "messages": [...], "stream": false },
  "expect_stream": false
}
```

`${API_KEY}` is substituted at load time.

## Diff rules

See spec §3 table. Summary: status strict-equal; headers allowlist-filtered with
value masking; JSON body deep-diff with `id/created/...` ignored; SSE structural
(event name + order + delta type, NOT prose).
