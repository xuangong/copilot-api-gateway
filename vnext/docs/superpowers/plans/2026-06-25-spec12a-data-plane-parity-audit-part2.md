# Spec 12a Data-Plane Parity Audit — Implementation Plan (Part 2 / 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal (Part 2):** 生成 27 条 fixture JSON 文件,并在能跑 Part 3 之前完成双起前置 audit (验证 root 与 vnext 都能起来 + env 不互踩)。

**Architecture (Part 2):** 每个 fixture 一个 `.json` 文件,放在 `vnext/scripts/parity/fixtures/data-plane/`。命名约定 `<family>-<variant>.json`,排序时按字母序加载,正好 27 个文件。Task 5 是 acceptance gate A1 (双起 health check),不写代码只跑命令并把结果记入 plan 输出。

**Tech Stack:** 纯 JSON、bash 命令、Docker Compose、`curl` / `bun run` / `gh`

**Spec reference:** `vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md` §2 双起 / §4 Fixtures (27 条) / §6 A1 / §7 风险

**前置:** Part 1 三 commit 已合入 (harness 与 diff engine 可跑)

---

## File Structure (Part 2)

| 文件 | 数 | 责任 |
|------|-----|------|
| `vnext/scripts/parity/fixtures/data-plane/chat-completions-*.json` | 3 | chat-completions family |
| `vnext/scripts/parity/fixtures/data-plane/messages-*.json` | 3 | Anthropic messages family (含 count_tokens) |
| `vnext/scripts/parity/fixtures/data-plane/responses-*.json` | 3 | OpenAI Responses family |
| `vnext/scripts/parity/fixtures/data-plane/gemini-*.json` | 4 | Gemini family (generate / stream / tool / countTokens) |
| `vnext/scripts/parity/fixtures/data-plane/embeddings-*.json` | 3 | embeddings family |
| `vnext/scripts/parity/fixtures/data-plane/images-*.json` | 3 | images generations / edits |
| `vnext/scripts/parity/fixtures/data-plane/models-*.json` | 3 | GET /models 三种 path |
| `vnext/scripts/parity/fixtures/data-plane/alias-*.json` | 5 | 非 v1 alias 覆盖 (e1-e5) |
| `vnext/scripts/parity/fixtures/data-plane/_README.md` | 1 | fixture 命名规则 |
| `vnext/docs/superpowers/research/2026-06-25-spec12a-precheck.md` | 1 | Task 5 双起前置 audit 结果 (gate A1) |

**总:** 27 fixture JSON + 1 README + 1 precheck research note。

---

## Task 4: 27 条 fixture JSON

**Files:** 见上表 27+1 文件

**前置常量 (fixture 中复用):**
- `${API_KEY}` 由 harness loader 替换,fixtures 中保留字面量
- `cheapest model` 选型:OpenAI=`gpt-4o-mini`,Anthropic=`claude-haiku-4-5`,Gemini=`gemini-2.5-flash`,embeddings=`text-embedding-3-small`,images=`dall-e-2`
- 8×8 透明 PNG base64:`iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGNgYGD4z8DAwMDEwMDAAAALBgEAh4VqgAAAAABJRU5ErkJggg==`

### Step 1: 写 chat-completions 3 条

- [ ] **Step 1.1: 创建 `chat-completions-basic-non-stream.json`**

写入 `vnext/scripts/parity/fixtures/data-plane/chat-completions-basic-non-stream.json`:

```json
{
  "name": "chat-completions-basic-non-stream",
  "endpoint": "/v1/chat/completions",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": {
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Reply with exactly: ok" }],
    "stream": false,
    "max_tokens": 16
  },
  "expect_stream": false
}
```

- [ ] **Step 1.2: 创建 `chat-completions-stream-include-usage.json`**

写入 `vnext/scripts/parity/fixtures/data-plane/chat-completions-stream-include-usage.json`:

```json
{
  "name": "chat-completions-stream-include-usage",
  "endpoint": "/v1/chat/completions",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": {
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Reply with exactly: ok" }],
    "stream": true,
    "stream_options": { "include_usage": true },
    "max_tokens": 16
  },
  "expect_stream": true
}
```

- [ ] **Step 1.3: 创建 `chat-completions-tool-required.json`**

写入 `vnext/scripts/parity/fixtures/data-plane/chat-completions-tool-required.json`:

```json
{
  "name": "chat-completions-tool-required",
  "endpoint": "/v1/chat/completions",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": {
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Use the get_weather tool for Tokyo." }],
    "stream": false,
    "tool_choice": "required",
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get the current weather for a city",
          "parameters": {
            "type": "object",
            "properties": { "city": { "type": "string" } },
            "required": ["city"]
          }
        }
      }
    ],
    "max_tokens": 64
  },
  "expect_stream": false
}
```

### Step 2: 写 messages 3 条

- [ ] **Step 2.1: `messages-basic-non-stream.json`**

```json
{
  "name": "messages-basic-non-stream",
  "endpoint": "/v1/messages",
  "method": "POST",
  "headers": {
    "x-api-key": "${API_KEY}",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  },
  "body": {
    "model": "claude-haiku-4-5",
    "max_tokens": 16,
    "messages": [{ "role": "user", "content": "Reply with exactly: ok" }]
  },
  "expect_stream": false
}
```

- [ ] **Step 2.2: `messages-stream.json`**

```json
{
  "name": "messages-stream",
  "endpoint": "/v1/messages",
  "method": "POST",
  "headers": {
    "x-api-key": "${API_KEY}",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  },
  "body": {
    "model": "claude-haiku-4-5",
    "max_tokens": 16,
    "stream": true,
    "messages": [{ "role": "user", "content": "Reply with exactly: ok" }]
  },
  "expect_stream": true
}
```

- [ ] **Step 2.3: `messages-count-tokens.json`**

```json
{
  "name": "messages-count-tokens",
  "endpoint": "/v1/messages/count_tokens",
  "method": "POST",
  "headers": {
    "x-api-key": "${API_KEY}",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  },
  "body": {
    "model": "claude-haiku-4-5",
    "messages": [{ "role": "user", "content": "Hello world" }]
  },
  "expect_stream": false
}
```

### Step 3: 写 responses 3 条

- [ ] **Step 3.1: `responses-basic-non-stream.json`**

```json
{
  "name": "responses-basic-non-stream",
  "endpoint": "/v1/responses",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": {
    "model": "gpt-4o-mini",
    "input": "Reply with exactly: ok",
    "max_output_tokens": 16,
    "stream": false
  },
  "expect_stream": false
}
```

- [ ] **Step 3.2: `responses-stream.json`**

```json
{
  "name": "responses-stream",
  "endpoint": "/v1/responses",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": {
    "model": "gpt-4o-mini",
    "input": "Reply with exactly: ok",
    "max_output_tokens": 16,
    "stream": true
  },
  "expect_stream": true
}
```

- [ ] **Step 3.3: `responses-stateful-chain.json`**

注:本 fixture 是 "第二跳",`previous_response_id` 由 harness 在 Part 3 真跑前先用 fixture 3.1 拿到。先用占位 `__PREV__`,在 Part 3 runner 里支持 `${PREV_RESPONSE_ID}` 类似替换。本 part 只写文件结构。

```json
{
  "name": "responses-stateful-chain",
  "endpoint": "/v1/responses",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": {
    "model": "gpt-4o-mini",
    "input": "And now reply with exactly: ok2",
    "previous_response_id": "${PREV_RESPONSE_ID}",
    "max_output_tokens": 16,
    "stream": false
  },
  "expect_stream": false
}
```

### Step 4: 写 gemini 4 条

- [ ] **Step 4.1: `gemini-generate-content.json`**

```json
{
  "name": "gemini-generate-content",
  "endpoint": "/v1beta/models/gemini-2.5-flash:generateContent",
  "method": "POST",
  "headers": { "x-goog-api-key": "${API_KEY}", "content-type": "application/json" },
  "body": {
    "contents": [{ "role": "user", "parts": [{ "text": "Reply with exactly: ok" }] }],
    "generationConfig": { "maxOutputTokens": 16 }
  },
  "expect_stream": false
}
```

- [ ] **Step 4.2: `gemini-stream-generate-content.json`**

```json
{
  "name": "gemini-stream-generate-content",
  "endpoint": "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
  "method": "POST",
  "headers": { "x-goog-api-key": "${API_KEY}", "content-type": "application/json" },
  "body": {
    "contents": [{ "role": "user", "parts": [{ "text": "Reply with exactly: ok" }] }],
    "generationConfig": { "maxOutputTokens": 16 }
  },
  "expect_stream": true
}
```

- [ ] **Step 4.3: `gemini-tool-call.json`**

```json
{
  "name": "gemini-tool-call",
  "endpoint": "/v1beta/models/gemini-2.5-flash:generateContent",
  "method": "POST",
  "headers": { "x-goog-api-key": "${API_KEY}", "content-type": "application/json" },
  "body": {
    "contents": [{ "role": "user", "parts": [{ "text": "Use get_weather for Tokyo" }] }],
    "tools": [
      {
        "functionDeclarations": [
          {
            "name": "get_weather",
            "description": "Get the current weather for a city",
            "parameters": {
              "type": "object",
              "properties": { "city": { "type": "string" } },
              "required": ["city"]
            }
          }
        ]
      }
    ],
    "generationConfig": { "maxOutputTokens": 64 }
  },
  "expect_stream": false
}
```

- [ ] **Step 4.4: `gemini-count-tokens.json`**

```json
{
  "name": "gemini-count-tokens",
  "endpoint": "/v1beta/models/gemini-2.5-flash:countTokens",
  "method": "POST",
  "headers": { "x-goog-api-key": "${API_KEY}", "content-type": "application/json" },
  "body": {
    "contents": [{ "role": "user", "parts": [{ "text": "Hello world" }] }]
  },
  "expect_stream": false
}
```

### Step 5: 写 embeddings 3 条

- [ ] **Step 5.1: `embeddings-single-string.json`**

```json
{
  "name": "embeddings-single-string",
  "endpoint": "/v1/embeddings",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": { "model": "text-embedding-3-small", "input": "hello world" },
  "expect_stream": false
}
```

- [ ] **Step 5.2: `embeddings-array-three.json`**

```json
{
  "name": "embeddings-array-three",
  "endpoint": "/v1/embeddings",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": { "model": "text-embedding-3-small", "input": ["alpha", "beta", "gamma"] },
  "expect_stream": false
}
```

- [ ] **Step 5.3: `embeddings-bad-model-4xx.json`**

```json
{
  "name": "embeddings-bad-model-4xx",
  "endpoint": "/v1/embeddings",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": { "model": "nonexistent-model-xyz", "input": "hello" },
  "expect_stream": false
}
```

### Step 6: 写 images 3 条

- [ ] **Step 6.1: `images-generations-basic.json`**

```json
{
  "name": "images-generations-basic",
  "endpoint": "/v1/images/generations",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": { "model": "dall-e-2", "prompt": "a red circle on white background", "n": 1, "size": "256x256" },
  "expect_stream": false
}
```

- [ ] **Step 6.2: `images-edits-png.json`**

注:`/v1/images/edits` 走 multipart。fixture 用 JSON 描述,Part 3 runner 中检测 `multipart: true` 标志,转 multipart 编码。本 fixture 用 8×8 透明 PNG。

```json
{
  "name": "images-edits-png",
  "endpoint": "/v1/images/edits",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}" },
  "body": {
    "multipart": true,
    "fields": {
      "model": "dall-e-2",
      "prompt": "add a small red dot",
      "size": "256x256",
      "n": 1
    },
    "files": {
      "image": {
        "filename": "tiny.png",
        "content_type": "image/png",
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGNgYGD4z8DAwMDEwMDAAAALBgEAh4VqgAAAAABJRU5ErkJggg=="
      }
    }
  },
  "expect_stream": false
}
```

(Part 3 task 6 会在 `fetchSide` 中加 multipart 处理分支。)

- [ ] **Step 6.3: `images-bad-size-4xx.json`**

```json
{
  "name": "images-bad-size-4xx",
  "endpoint": "/v1/images/generations",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": { "model": "dall-e-2", "prompt": "x", "size": "1x1" },
  "expect_stream": false
}
```

### Step 7: 写 models 3 条

- [ ] **Step 7.1: `models-v1.json`**

```json
{
  "name": "models-v1",
  "endpoint": "/v1/models",
  "method": "GET",
  "headers": { "authorization": "Bearer ${API_KEY}" },
  "expect_stream": false
}
```

- [ ] **Step 7.2: `models-root.json`**

```json
{
  "name": "models-root",
  "endpoint": "/models",
  "method": "GET",
  "headers": { "authorization": "Bearer ${API_KEY}" },
  "expect_stream": false
}
```

- [ ] **Step 7.3: `models-api.json`**

```json
{
  "name": "models-api",
  "endpoint": "/api/models",
  "method": "GET",
  "headers": { "authorization": "Bearer ${API_KEY}" },
  "expect_stream": false
}
```

### Step 8: 写 alias-only 5 条 (e1-e5)

- [ ] **Step 8.1: `alias-e1-chat-completions.json`** — 与 1.1 同 body,endpoint 去 v1

```json
{
  "name": "alias-e1-chat-completions",
  "endpoint": "/chat/completions",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": {
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Reply with exactly: ok" }],
    "stream": false,
    "max_tokens": 16
  },
  "expect_stream": false
}
```

- [ ] **Step 8.2: `alias-e2-responses.json`**

```json
{
  "name": "alias-e2-responses",
  "endpoint": "/responses",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": {
    "model": "gpt-4o-mini",
    "input": "Reply with exactly: ok",
    "max_output_tokens": 16,
    "stream": false
  },
  "expect_stream": false
}
```

- [ ] **Step 8.3: `alias-e3-embeddings.json`**

```json
{
  "name": "alias-e3-embeddings",
  "endpoint": "/embeddings",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": { "model": "text-embedding-3-small", "input": "hello world" },
  "expect_stream": false
}
```

- [ ] **Step 8.4: `alias-e4-images-generations.json`**

```json
{
  "name": "alias-e4-images-generations",
  "endpoint": "/images/generations",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}", "content-type": "application/json" },
  "body": { "model": "dall-e-2", "prompt": "a red circle on white background", "n": 1, "size": "256x256" },
  "expect_stream": false
}
```

- [ ] **Step 8.5: `alias-e5-images-edits.json`**

```json
{
  "name": "alias-e5-images-edits",
  "endpoint": "/images/edits",
  "method": "POST",
  "headers": { "authorization": "Bearer ${API_KEY}" },
  "body": {
    "multipart": true,
    "fields": {
      "model": "dall-e-2",
      "prompt": "add a small red dot",
      "size": "256x256",
      "n": 1
    },
    "files": {
      "image": {
        "filename": "tiny.png",
        "content_type": "image/png",
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGNgYGD4z8DAwMDEwMDAAAALBgEAh4VqgAAAAABJRU5ErkJggg=="
      }
    }
  },
  "expect_stream": false
}
```

### Step 9: 写 fixture README

- [ ] **Step 9.1: 创建 `vnext/scripts/parity/fixtures/data-plane/_README.md`**

```markdown
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
```

### Step 10: 跑 fixture loader 验证

- [ ] **Step 10.1: 写临时验证脚本(inline,不入库)**

Run:
```bash
cd vnext && PARITY_API_KEY=dummy bun -e "
import { loadFixtures } from './scripts/parity/data-plane-audit'
const fx = loadFixtures()
console.log('count:', fx.length)
console.log('names:', fx.map(f => f.name).join('\n'))
const dupes = fx.map(f => f.name).filter((n, i, a) => a.indexOf(n) !== i)
if (dupes.length) { console.error('DUPLICATES:', dupes); process.exit(1) }
const families = new Set(fx.map(f => f.name.split('-')[0]))
console.log('families:', [...families].sort().join(','))
"
```

Expected:
- `count: 27`
- 27 unique names (无 dupe)
- families 含 alias / chat / embeddings / gemini / images / messages / models / responses

### Step 11: Commit

- [ ] **Step 11.1: Commit fixtures**

```bash
git add vnext/scripts/parity/fixtures/data-plane/
git commit -m "$(cat <<'EOF'
feat(vnext/spec12a): 27 data-plane parity fixtures

Part 2 task 4: One JSON file per fixture per spec §4 (27 total).

- chat-completions: basic / stream+include_usage / tool_choice=required (3)
- messages: basic / stream / count_tokens (3)
- responses: basic / stream / stateful (${PREV_RESPONSE_ID} placeholder) (3)
- gemini: generateContent / streamGenerateContent?alt=sse / tool / countTokens (4)
- embeddings: single / array(3) / bad-model-4xx (3)
- images: generations / edits (multipart, 8x8 PNG) / bad-size-4xx (3)
- models: /v1/models, /models, /api/models (GET) (3)
- alias-only: e1-e5 non-v1 paths (3 chat/responses/embeddings + 2 images) (5)

${API_KEY} substituted at load; ${PREV_RESPONSE_ID} substituted by Part 3
runner; multipart fields wired via { multipart: true, fields, files } body
flag (runner support in Part 3 task 6).

Spec: vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md §4

Generated with Claude Code via Happy

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

## Task 5: 双起前置 audit (Spec gate A1 + §7 blocker check)

**Files:**
- Create: `vnext/docs/superpowers/research/2026-06-25-spec12a-precheck.md`

**目的:** 在 Part 3 跑 27 fixture 之前先做 sanity check — 两个 server 都能起来、`/v1/models` 都给 200 或 401 (一致),env 不互踩。如果失败,本 task 把 blocker 记入 research note,Part 3 不启动 (spec §7)。

- [ ] **Step 1: 验证 env 隔离 (sqlite 路径)**

Run:
```bash
grep -h 'DATA_DIR\|copilot.db\|/data' .env .env.vnext 2>&1 | head -20
ls -la .data/ data-vnext/ 2>&1 | head
```

Expected:
- root 用 `.data/copilot.db` (项目根 `.data/` 目录)
- vnext 用 `data-vnext/` 目录 (mount 到容器 `/data/`)
- 两者路径无交集 → 不会互踩

记录到 precheck note 的 "Env 隔离" 章节。

- [ ] **Step 2: 验证 GH token 是否同源**

Run:
```bash
diff <(grep VNEXT_DEV_GITHUB_TOKEN .env.vnext | cut -d= -f2 | head -c 8) \
     <(grep -E '^GITHUB_TOKEN' .env 2>/dev/null | cut -d= -f2 | head -c 8) \
  && echo "TOKEN-SHARED" || echo "TOKEN-DIFFERENT-OR-MISSING"
```

注:不打印完整 token,只看前 8 字符是否一致。结果决定 Part 3 是否强制串行。

记录结果。

- [ ] **Step 3: 启动 root server (后台)**

Run:
```bash
(PORT=4141 bun run local > /tmp/spec12a-root.log 2>&1 &) && sleep 5
curl -s -o /dev/null -w 'root /v1/models HTTP %{http_code}\n' http://127.0.0.1:4141/v1/models
```

Expected:
- HTTP 200 (token 有效) 或 HTTP 401 (token 缺/无效) — 都算"起来了"
- 若 HTTP 000 / connection refused → root 起不来,记入 blocker

- [ ] **Step 4: 启动 vnext (docker compose)**

Run:
```bash
docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d
sleep 8
curl -s -o /dev/null -w 'vnext /v1/models HTTP %{http_code}\n' http://127.0.0.1:41415/v1/models
docker compose -f docker-compose.vnext.yml logs --tail 20 gateway-vnext | tail -20
```

Expected:
- HTTP 200 或 HTTP 401 — 都算"起来了"
- 若 502 / 504 / connection refused → vnext 起不来,记入 blocker

- [ ] **Step 5: A1 gate 判定**

期望:两边都返回 200 (一致) 或都返回 401 (一致)。若一边 200 一边 401 → token 互踩,Part 3 必须强制串行,且把 fixture 头里的 token 改成共用值。

记录两端 status 对比。

- [ ] **Step 6: 关闭 servers (precheck 完后,Part 3 重起)**

Run:
```bash
docker compose -f docker-compose.vnext.yml down
pkill -f 'bun.*src/local.ts' 2>/dev/null || true
```

- [ ] **Step 7: 写 precheck research note**

写入 `vnext/docs/superpowers/research/2026-06-25-spec12a-precheck.md`:

```markdown
# Spec 12a — Pre-check (双起 A1 gate)

**Date:** 2026-06-25
**Spec:** `vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md` §2 / §6 A1 / §7

## Env isolation

| concern | root | vnext | verdict |
|---------|------|-------|---------|
| sqlite path | `.data/copilot.db` | `data-vnext/` → container `/data/` | isolated ✅ |
| GH token | (from `.env`) | (from `.env.vnext` `VNEXT_DEV_GITHUB_TOKEN`) | <SHARED \| DIFFERENT> |
| port | 4141 (overridden from default 41414) | 41415 | distinct ✅ |

## Health check

| server | start cmd | URL | status |
|--------|-----------|-----|--------|
| root | `PORT=4141 bun run local` | `http://127.0.0.1:4141/v1/models` | <HTTP> |
| vnext | `docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d` | `http://127.0.0.1:41415/v1/models` | <HTTP> |

## A1 verdict

- both 200 OR both 401 → **PASS** (Part 3 may proceed)
- mismatch (200 vs 401) → **FAIL** (token不共用;Part 3 修 fixture 头)
- 任一 connection refused → **BLOCKER**,记录如下并不启动 Part 3

## Blockers (if any)

<填入命中的 blocker 描述,无则写 "None">

## Concurrency decision

- token shared → Part 3 串行 (sequential, no concurrency)
- token different → Part 3 可并行 (默认仍串行以省力)
```

把 step 1-5 的实际输出填入对应位置。

- [ ] **Step 8: Commit precheck note**

```bash
git add vnext/docs/superpowers/research/2026-06-25-spec12a-precheck.md
git commit -m "$(cat <<'EOF'
docs(vnext/spec12a): pre-check research note (A1 health + env isolation)

Part 2 task 5: Records the dual-server warm-up before the 27-fixture run.
Verifies sqlite paths don't collide (.data/copilot.db vs data-vnext/),
captures whether the GH token is shared (drives Part 3 serial decision),
and confirms both servers respond on /v1/models with matching status
(200 or 401). Blockers, if any, gate Part 3.

Spec: vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md §6 A1 / §7

Generated with Claude Code via Happy

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

注:此 commit 与 Part 2 task 4 的 fixtures commit 是同一个 logical commit boundary (spec §9 表中 commit 3 = harness+fixtures);但 precheck note 属于 commit 4 (report) 还是单独 commit?**决定:precheck 与 fixtures 合到 commit 3 的 follow-up 也可以,但本 plan 为可追溯把它写成独立 commit。**Spec §9 的 4-commit layout 仅是建议骨架,允许有 precheck 这种额外辅助 commit (因为它产出的是 research 而非 spec/plan/harness/report)。

---

## Part 2 Deliverable

完成本 part 后:
- 27 个 fixture JSON 文件 (loader count=27 已验证)
- fixture README
- precheck research note (A1 已 pass 或 blocker 已记录)
- 2 个 commit (task 4 fixtures + task 5 precheck)

**未完成:** real fetch wiring + multipart 支持 + `${PREV_RESPONSE_ID}` 替换 + 真跑 + report 生成 + 4 commit layout 完成 → Part 3。

**Self-review:**

1. **Spec coverage (本 part 范围):**
   - Spec §4 27 fixture 全列 → ✅ 3+3+3+4+3+3+3+5=27,与 task step 全对齐
   - Spec §2 双起 health check → ✅ Task 5
   - Spec §7 env 互斥 / token 共用 / sqlite 路径 → ✅ Task 5 step 1-2
   - Spec §6 A1 gate → ✅ Task 5 step 5
2. **Placeholder scan:** 所有 fixture body 都给了完整字段;`${API_KEY}`/`${PREV_RESPONSE_ID}` 是设计内变量,会被 loader / runner 替换。✅
3. **Type consistency:** 所有 fixture 满足 Part 1 的 `Fixture` interface (name/endpoint/method/headers/body?/expect_stream)。multipart 走 body.multipart=true 子字段,需 Part 3 task 6 在 fetchSide 中加分支。✅

Part 3 (real fetch wiring + multipart + 真跑 + report + A2/A3/A4/A5 验收) 在续篇。
