import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = process.env.VNEXT_PROBE_ROOT
const scratch = process.env.PROVENANCE_EVIDENCE_DIR
assert(root && scratch, 'Set VNEXT_PROBE_ROOT and PROVENANCE_EVIDENCE_DIR to isolated local paths')
await mkdir(scratch, { recursive: true })
const require = createRequire(`${root}/vnext/apps/platform-cloudflare/package.json`)
const { Miniflare } = await import(require.resolve('miniflare'))
const { unstable_splitSqlQuery } = await import(require.resolve('wrangler'))
const entry = resolve(scratch, 'worker.ts'), bundle = resolve(scratch, 'worker.mjs')
await writeFile(entry, (await readFile(new URL('./workerd-entry.ts.txt', import.meta.url), 'utf8')).replaceAll('__ROOT__', root))
const build = spawnSync('bun', ['build', entry, '--target=node', `--outfile=${bundle}`], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const calls = []
let serial = 0
const answer = 'Synthetic answer'
function response(path, body) {
  serial++
  let result, events
  if (path.endsWith('/messages')) {
    const content = [{ type: 'text', text: answer }]
    result = { id: `msg_${serial}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    events = [{ type: 'message_start', message: { ...result, content: [], stop_reason: null } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]
  } else if (path.endsWith('/chat/completions')) {
    result = { id: `chat_${serial}`, object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    events = [{ ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta: result.choices[0].message, finish_reason: null }] }, { ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
  } else {
    const item = { type: 'message', id: `msg_${serial}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] }
    result = { id: `resp_${serial}`, object: 'response', model: body.model, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    events = [{ type: 'response.created', sequence_number: 0, response: { ...result, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, content: [] } }, { type: 'response.content_part.added', sequence_number: 2, output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', sequence_number: 3, output_index: 0, content_index: 0, item_id: item.id, delta: answer }, { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item }, { type: 'response.completed', sequence_number: 5, response: result }]
  }
  if (!body.stream) return Response.json(result)
  return new Response(events.map(event => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (path.endsWith('/chat/completions') ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
}
const mf = new Miniflare({ modules: true, modulesRoot: scratch, scriptPath: bundle, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'origin-roundtrip' }, r2Buckets: { FILES: 'origin-files' }, outboundService: async req => {
  assert.equal(new URL(req.url).hostname, 'synthetic.invalid')
  const body = await req.json()
  calls.push({ path: new URL(req.url).pathname, body })
  return response(new URL(req.url).pathname, body)
} })
const cases = [], failures = []
function events(text) { return text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6))) }
function history(protocol, result, stream) {
  const frames = stream ? events(result.text) : []
  const body = stream ? undefined : result.json
  if (protocol === 'responses') {
    const final = stream ? frames.find(event => event.type === 'response.completed')?.response : body
    assert(final?.output?.some(item => item.encrypted_content?.startsWith('vnext-affinity:2:')), result.text)
    if (stream) {
      const prefix = final.output[0]
      assert.deepEqual(frames.find(event => event.type === 'response.output_item.done' && event.item?.id === prefix.id)?.item, prefix)
      const sequence = frames.filter(event => Number.isInteger(event.sequence_number)).map(event => event.sequence_number)
      assert.equal(new Set(sequence).size, sequence.length)
    }
    return { input: final.output, responseId: final.id }
  }
  if (protocol === 'chat_completions') {
    const message = stream ? { role: 'assistant', content: '', reasoning_opaque: '' } : body.choices[0].message
    if (stream) for (const event of frames) for (const choice of event.choices ?? []) {
      message.content += choice.delta?.content ?? ''
      message.reasoning_opaque += choice.delta?.reasoning_opaque ?? ''
    }
    assert.equal(message.content, answer)
    assert(message.reasoning_opaque.startsWith('vnext-affinity:2:'), result.text)
    return { messages: [message, { role: 'user', content: 'continue' }] }
  }
  if (protocol === 'messages') {
    const content = stream ? [] : body.content
    if (stream) for (const event of frames) {
      if (event.type === 'content_block_start') content[event.index] = { ...event.content_block }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') content[event.index].text += event.delta.text
      if (event.type === 'content_block_delta' && event.delta.type === 'signature_delta') content[event.index].signature = (content[event.index].signature ?? '') + event.delta.signature
    }
    assert(content.some(block => block.type === 'redacted_thinking' && block.data.startsWith('vnext-affinity:2:')), result.text)
    assert(content.some(block => block.text === answer))
    return { messages: [{ role: 'assistant', content }, { role: 'user', content: 'continue' }] }
  }
  const content = stream ? { role: 'model', parts: frames.flatMap(event => event.candidates?.flatMap(candidate => candidate.content?.parts ?? []) ?? []) } : body.candidates[0].content
  assert(content.parts.some(part => part.thoughtSignature?.startsWith('vnext-affinity:2:')), result.text)
  // Go GenAI Chat validates every Part, not merely whether the turn has text.
  for (const part of content.parts) assert(part.text || part.inlineData || part.fileData || part.functionCall || part.functionResponse || part.executableCode || part.codeExecutionResult, 'Empty origin Part invalidates Go Chat history')
  return { contents: [content, { role: 'user', parts: [{ text: 'continue' }] }] }
}
try {
  const db = await mf.getD1Database('DB')
  for (const file of (await readdir(`${root}/vnext/packages/gateway/migrations`)).filter(file => file.endsWith('.sql')).sort()) {
    for (const sql of unstable_splitSqlQuery(await readFile(`${root}/vnext/packages/gateway/migrations/${file}`, 'utf8'))) await db.prepare(sql).run()
  }
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind('owner', 'Synthetic', 'synthetic@example.invalid', now).run()
  for (const key of ['key', 'other']) await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)').bind(key, key, `raw-${key}`, now, 'owner', 86400).run()
  for (const endpoint of ['chat_completions', 'messages', 'responses']) {
    const id = `up_${endpoint}`
    await db.prepare('INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(id, 'owner', 'custom', id, JSON.stringify({ name: id, baseUrl: `https://synthetic.invalid/${id}`, authStyle: 'none', endpoints: [endpoint], models: ['synthetic-model'] }), '[{"id":"direct_fetch"}]', now, now).run()
  }
  const request = async (protocol, target, stream, input = {}, key = 'key') => {
    const model = `up_${target}/synthetic-model`
    const path = protocol === 'gemini' ? `/v1beta/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent' : 'generateContent'}` : protocol === 'chat_completions' ? '/v1/chat/completions' : `/v1/${protocol}`
    const initial = protocol === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }] } : protocol === 'responses' ? { input: 'synthetic' } : { messages: [{ role: 'user', content: 'synthetic' }], max_tokens: 100 }
    const { responseId: _id, ...payload } = input
    const body = { ...(protocol === 'gemini' ? {} : { model, stream }), ...initial, ...payload }
    const result = await mf.dispatchFetch(`http://local${path}`, { method: 'POST', headers: { authorization: `Bearer raw-${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await result.text()
    return { status: result.status, text, json: !stream ? JSON.parse(text) : undefined }
  }
  for (const protocol of ['responses', 'messages', 'chat_completions', 'gemini']) for (const target of ['responses', 'messages', 'chat_completions']) for (const stream of [false, true]) {
    const name = `${protocol}->${target}/${stream ? 'SSE' : 'JSON'}`
    try {
      const first = await request(protocol, target, stream)
      assert.equal(first.status, 200, first.text)
      const replay = history(protocol, first, stream)
      const second = await request(protocol, target, false, replay)
      assert.equal(second.status, 200, second.text)
      assert(!JSON.stringify(calls.at(-1).body).includes('vnext-affinity:'), 'Carrier leaked upstream')
      assert(JSON.stringify(calls.at(-1).body).includes(answer), 'Assistant text lost on replay')
      const before = calls.length
      const wrongKey = await request(protocol, target, false, replay, 'other')
      assert.equal(wrongKey.status, 400, wrongKey.text)
      assert.equal(calls.length, before, 'Unauthenticated origin reached inference')
      const corrupt = JSON.parse(JSON.stringify(replay).replace('vnext-affinity:2:', 'vnext-affinity:9:'))
      assert.equal((await request(protocol, target, false, corrupt)).status, 400)
      assert.equal(calls.length, before)
      if (protocol === 'responses' && target === 'responses') {
        const inherited = { input: [...replay.input, { type: 'program_output', result: 'fixture-state' }] }
        const continued = await request(protocol, target, false, inherited)
        assert.equal(continued.status, 200, continued.text)
        assert(JSON.stringify(calls.at(-1).body).includes('fixture-state'))
        const count = calls.length
        const mismatch = await request(protocol, 'chat_completions', false, inherited)
        assert.equal(mismatch.status, 503, mismatch.text)
        assert.equal(calls.length, count)
        const stored = await request(protocol, target, false, { previous_response_id: replay.responseId, input: [{ type: 'program_output', result: 'stored-state' }] })
        assert.equal(stored.status, 200, stored.text)
        assert(JSON.stringify(calls.at(-1).body).includes('stored-state'))
        assert(!JSON.stringify(calls.at(-1).body).includes('vnext-affinity:'))
      }
      cases.push(name)
    } catch (error) { failures.push({ name, error: String(error) }) }
  }
  await (await mf.dispatchFetch('http://local/__fixture/drain')).text()
  const result = { passed: failures.length === 0, runtime: 'full app/workerd/WebCrypto/local D1', bundleSha256: createHash('sha256').update(await readFile(bundle)).digest('hex'), cases, failures, calls: calls.length }
  await writeFile(resolve(scratch, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result))
  assert.equal(failures.length, 0, JSON.stringify(failures))
} finally { await mf.dispose() }
