import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = process.env.VNEXT_PROBE_ROOT
const scratch = process.env.CLAUDE_LEASE_EVIDENCE_DIR
assert(root && scratch, 'Set VNEXT_PROBE_ROOT and CLAUDE_LEASE_EVIDENCE_DIR to isolated local paths')
await mkdir(scratch, { recursive: true })
const require = createRequire(`${root}/vnext/apps/platform-cloudflare/package.json`)
const { Miniflare } = await import(require.resolve('miniflare'))
const { unstable_splitSqlQuery } = await import(require.resolve('wrangler'))
const entry = resolve(scratch, 'worker.ts'), bundle = resolve(scratch, 'worker.mjs')
await writeFile(entry, (await readFile(new URL('./workerd-entry.ts.txt', import.meta.url), 'utf8')).replaceAll('__ROOT__', root))
const build = spawnSync('bun', ['build', entry, '--target=node', `--outfile=${bundle}`], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)

const rawModel = 'claude-sonnet-4-5-20250929', alias = 'claude-sonnet-4-5'
const answer = 'Synthetic Claude answer', nativeSignature = 'synthetic-native-signature'
const calls = [], cases = []
let native = false, rejectOnce = false, serial = 0
function messages(body) {
  const result = { id: `msg_${++serial}`, type: 'message', role: 'assistant', model: rawModel, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 1 } }
  const events = [{ type: 'message_start', message: result }]
  let index = 0
  if (native) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'Synthetic reasoning' } },
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: nativeSignature } },
      { type: 'content_block_stop', index })
    index++
  }
  events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text: answer } },
    { type: 'content_block_stop', index },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' })
  assert.equal(body.stream, true)
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
const mf = new Miniflare({ modules: true, modulesRoot: scratch, scriptPath: bundle, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'claude-lease-roundtrip' }, r2Buckets: { FILES: 'claude-lease-files' }, outboundService: async req => {
  const url = new URL(req.url)
  assert(['api.anthropic.com', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname), `Unexpected outbound host: ${url.hostname}`)
  if (url.pathname === '/v1/models') {
    calls.push({ kind: 'catalog' })
    return Response.json({ data: [{ id: rawModel, display_name: 'Synthetic Sonnet', max_input_tokens: 200000, capabilities: { thinking: { types: { enabled: { supported: true } } } } }] })
  }
  if (url.pathname.endsWith('/oauth/token')) {
    calls.push({ kind: 'refresh' })
    return Response.json({ access_token: 'synthetic-refreshed-access', refresh_token: 'synthetic-refreshed-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'user:inference' })
  }
  assert.equal(url.pathname, '/v1/messages')
  const body = await req.json()
  assert.equal(body.model, rawModel)
  assert(!JSON.stringify(body).includes('vnext-affinity:'), 'Gateway metadata reached Anthropic')
  const bearer = req.headers.get('authorization')
  assert(['Bearer synthetic-access', 'Bearer synthetic-refreshed-access'].includes(bearer))
  calls.push({ kind: 'inference', body, refreshed: bearer === 'Bearer synthetic-refreshed-access' })
  if (rejectOnce) { rejectOnce = false; return new Response('synthetic cached token rejected', { status: 401 }) }
  return messages(body)
} })

function frames(text) { return text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6))) }
function history(protocol, result, stream) {
  const events = stream ? frames(result.text) : [], body = stream ? undefined : result.json
  if (protocol === 'responses') {
    const final = stream ? events.find(event => event.type === 'response.completed')?.response : body
    assert(final?.output?.some(item => item.encrypted_content?.startsWith('vnext-affinity:2:')), result.text)
    assert(JSON.stringify(final.output).includes(answer), result.text)
    return { input: final.output }
  }
  if (protocol === 'chat_completions') {
    const message = stream ? { role: 'assistant', content: '', reasoning_opaque: '' } : body.choices[0].message
    if (stream) for (const event of events) for (const choice of event.choices ?? []) {
      message.content += choice.delta?.content ?? ''
      message.reasoning_opaque += choice.delta?.reasoning_opaque ?? ''
    }
    assert.equal(message.content, answer)
    assert(message.reasoning_opaque.startsWith('vnext-affinity:2:'), result.text)
    return { messages: [message, { role: 'user', content: 'continue' }] }
  }
  if (protocol === 'messages') {
    const content = stream ? [] : body.content
    if (stream) for (const event of events) {
      if (event.type === 'content_block_start') content[event.index] = { ...event.content_block }
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') content[event.index].text += event.delta.text
        if (event.delta.type === 'thinking_delta') content[event.index].thinking += event.delta.thinking
        if (event.delta.type === 'signature_delta') content[event.index].signature = (content[event.index].signature ?? '') + event.delta.signature
      }
    }
    assert(content.some(block => block.type === 'redacted_thinking' && block.data.startsWith('vnext-affinity:2:')), result.text)
    assert(content.some(block => block.text === answer))
    if (native) assert(content.some(block => block.signature?.startsWith('vnext-affinity:1:')))
    return { messages: [{ role: 'assistant', content }, { role: 'user', content: 'continue' }] }
  }
  const content = stream ? { role: 'model', parts: events.flatMap(event => event.candidates?.flatMap(candidate => candidate.content?.parts ?? []) ?? []) } : body.candidates[0].content
  assert(content.parts.some(part => part.thoughtSignature?.startsWith('vnext-affinity:2:')), result.text)
  assert(content.parts.some(part => part.text === answer))
  return { contents: [content, { role: 'user', parts: [{ text: 'continue' }] }] }
}
try {
  const db = await mf.getD1Database('DB'), migrations = []
  for (const file of (await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(file => file.endsWith('.sql')).sort()) {
    for (const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${file}`, 'utf8'))) await db.prepare(sql).run()
    migrations.push(file)
  }
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind('owner', 'Synthetic', 'synthetic@example.invalid', now).run()
  await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)').bind('key', 'Synthetic', 'synthetic-key', now, 'owner', 86400).run()
  const account = { accountUuid: 'synthetic-account', tokenKind: 'oauth', refreshToken: 'synthetic-refresh', state: 'active', stateUpdatedAt: now, accessToken: { token: 'synthetic-access', expiresAt: Date.now() + 3600000, refreshedAt: now }, quotaSnapshot: null, usageProbeSnapshot: null }
  const config = { accounts: [{ accountUuid: account.accountUuid, email: null, organizationUuid: null, subscriptionType: 'max', rateLimitTier: null }] }
  await db.prepare('INSERT INTO upstreams(id,owner_id,provider,name,config_json,state_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind('claude', 'owner', 'claude-code', 'claude', JSON.stringify(config), JSON.stringify({ accounts: [account] }), '[{"id":"direct_fetch"}]', now, now).run()

  const request = async (protocol, stream, input = {}) => {
    const path = protocol === 'gemini' ? `/v1beta/models/${encodeURIComponent(alias)}:${stream ? 'streamGenerateContent' : 'generateContent'}` : protocol === 'chat_completions' ? '/v1/chat/completions' : `/v1/${protocol}`
    const initial = protocol === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }] } : protocol === 'responses' ? { input: 'synthetic' } : { messages: [{ role: 'user', content: 'synthetic' }], max_tokens: 2048 }
    const body = { ...(protocol === 'gemini' ? {} : { model: alias, stream }), ...initial, ...input }
    const response = await mf.dispatchFetch(`http://local${path}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-key', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await response.text()
    return { status: response.status, text, json: !stream ? JSON.parse(text) : undefined }
  }
  for (const protocol of ['responses', 'messages', 'chat_completions', 'gemini']) for (const stream of [false, true]) {
    const first = await request(protocol, stream)
    assert.equal(first.status, 200, first.text)
    const saved = history(protocol, first, stream)
    const second = await request(protocol, stream, saved)
    assert.equal(second.status, 200, second.text)
    history(protocol, second, stream)
    cases.push({ name: `${protocol}/${stream ? 'SSE' : 'JSON'}`, passed: true })
  }
  native = true
  let nativeHistory
  for (const stream of [false, true]) {
    const first = await request('messages', stream)
    assert.equal(first.status, 200, first.text)
    nativeHistory = history('messages', first, stream)
    rejectOnce = stream
    const start = calls.length
    const second = await request('messages', stream, nativeHistory)
    assert.equal(second.status, 200, second.text)
    history('messages', second, stream)
    const recent = calls.slice(start)
    assert(recent.filter(call => call.kind === 'inference').every(call => JSON.stringify(call.body).includes(nativeSignature)))
    if (stream) {
      assert.equal(recent.filter(call => call.kind === 'refresh').length, 1)
      assert.equal(recent.filter(call => call.kind === 'inference').length, 2)
      assert.equal(recent.at(-1).refreshed, true)
    }
    cases.push({ name: `native/${stream ? 'SSE+401' : 'JSON'}`, passed: true })
  }
  // Thinking can be dropped on an incompatible route when it has no tool
  // dependency. A tool-bearing turn must retain its signed reasoning.
  const requiredHistory = structuredClone(nativeHistory)
  requiredHistory.tools = [{ name: 'synthetic_tool', input_schema: { type: 'object', properties: {} } }]
  requiredHistory.messages[0].content.push({ type: 'tool_use', id: 'tool_fixture', name: 'synthetic_tool', input: {} })
  requiredHistory.messages[1] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_fixture', content: 'synthetic result' }] }
  const sameCredential = await request('messages', false, requiredHistory)
  assert.equal(sameCredential.status, 200, sameCredential.text)
  assert(JSON.stringify(calls.at(-1).body).includes(nativeSignature))
  cases.push({ name: 'native-tool-dependent-history-same-credential', passed: true })
  const replaced = await (await mf.dispatchFetch('http://local/__fixture/reimport')).json()
  assert.equal(replaced.after, replaced.before + 1)
  const before = calls.length
  const refused = await request('messages', false, requiredHistory)
  assert.equal(refused.status, 503, refused.text)
  assert.match(refused.text, /No authorized compatible route for opaque state/)
  assert(!calls.slice(before).some(call => call.kind === 'inference' || call.kind === 'refresh'), 'Old native state dispatched after same-byte reimport')
  cases.push({ name: 'same-byte-reimport-rejects-tool-dependent-native-state', passed: true })
  const degraded = await request('messages', false, nativeHistory)
  assert.equal(degraded.status, 200, degraded.text)
  assert(!JSON.stringify(calls.at(-1).body).includes(nativeSignature), 'Optional old native signature was forwarded to the replacement')
  cases.push({ name: 'same-byte-reimport-drops-optional-incompatible-thinking', passed: true })
  await mf.dispatchFetch('http://local/__fixture/drain')
  const result = { runtime: 'actual local workerd/full gateway/D1/WebCrypto', passed: true, migrations, cases, syntheticCalls: calls.map(({ kind }) => kind), bundleSha256: createHash('sha256').update(await readFile(bundle)).digest('hex') }
  await writeFile(resolve(scratch, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { await mf.dispose() }
