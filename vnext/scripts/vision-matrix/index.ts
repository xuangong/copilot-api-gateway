/**
 * Vision matrix — does an image survive every client protocol we accept?
 *
 * Each cell sends one freshly generated 2x2 colour grid (~1680 possible
 * arrangements, minted per run so nothing can be memorised) and asks the model
 * to read it back clockwise. A translator that drops, reshapes or reorders an
 * image block shows up as a wrong answer; a model that never saw the image
 * cannot guess its way to a pass.
 *
 * This exists because the Responses translators used to emit
 * `{ type: 'input_image', text: <url> }` instead of `image_url`. Unit tests
 * agreed with the bug — only an end-to-end probe caught it.
 *
 *   bun scripts/vision-matrix --key sk_... --models gpt-5.6-sol,claude-opus-5
 *   bun scripts/vision-matrix --key sk_... --all          # every chat model
 *   bun scripts/vision-matrix --key sk_... --capabilities # flag vs. reality
 *
 * Exit code is non-zero when a cell fails, so it can gate a release.
 */

import { quadrantPng } from './png'
import {
  buildRequest, extractText, grade, pickQuadrants, PROTOCOLS, seededRng,
  type Protocol,
} from './probe'

const PROMPT =
  'Name the colours of the four squares, clockwise starting from the top-left. ' +
  'Answer with exactly four lowercase english words separated by commas, nothing else.'

interface Options {
  base: string
  key: string
  models: string[]
  protocols: Protocol[]
  all: boolean
  capabilities: boolean
  seed: number
  timeoutMs: number
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] ?? '' : fallback
  }
  const has = (name: string) => argv.includes(`--${name}`)
  const key = get('key', process.env.GATEWAY_KEY)
  if (!key) throw new Error('missing --key (or GATEWAY_KEY)')
  return {
    base: get('base', process.env.GATEWAY_URL ?? 'http://localhost:41414')!,
    key,
    models: (get('models', '') || '').split(',').filter(Boolean),
    protocols: (get('protocols', '') || '').split(',').filter(Boolean) as Protocol[],
    all: has('all'),
    capabilities: has('capabilities'),
    // Default to a fresh grid each run; pass --seed to reproduce a failure.
    seed: Number(get('seed', String(Date.now() & 0xffff))),
    timeoutMs: Number(get('timeout', '90000')),
  }
}

/** Models the gateway serves, with whatever vision claim the upstream made. */
async function catalogue(o: Options): Promise<Array<{ id: string; visionClaim: boolean | null }>> {
  const resp = await fetch(`${o.base}/v1/models`, { headers: { 'x-api-key': o.key } })
  if (!resp.ok) throw new Error(`GET /v1/models → ${resp.status}`)
  const body = await resp.json() as { data: Array<Record<string, any>> }
  return body.data.map((m) => ({
    id: m.id as string,
    visionClaim: typeof m.capabilities?.supports?.vision === 'boolean'
      ? m.capabilities.supports.vision
      : null,
  }))
}

type Outcome =
  | { kind: 'pass'; answer: string }
  | { kind: 'wrong'; answer: string }
  | { kind: 'rejected'; detail: string }
  | { kind: 'error'; detail: string }

async function probe(o: Options, protocol: Protocol, model: string, seed: number): Promise<Outcome> {
  const quads = pickQuadrants(seededRng(seed))
  const png = quadrantPng(quads)
  const req = buildRequest(protocol, model, png, PROMPT, o.base, o.key)
  try {
    const resp = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      // Without this a stream that never closes hangs the whole matrix.
      signal: AbortSignal.timeout(o.timeoutMs),
    })
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '')
      const kind = /media type not supported|vision/i.test(text) ? 'rejected' : 'error'
      return { kind, detail: `HTTP ${resp.status}: ${text.replace(/\s+/g, ' ').slice(0, 120)}` }
    }
    const answer = (await readSse(resp.body, (e) => extractText(protocol, e))).trim()
    return grade(answer, quads)
      ? { kind: 'pass', answer }
      : { kind: 'wrong', answer: `${answer.replace(/\s+/g, ' ').slice(0, 60)} (expected ${quads.join(',')})` }
  } catch (e) {
    return { kind: 'error', detail: String((e as Error).message).slice(0, 120) }
  }
}

async function readSse(body: ReadableStream<Uint8Array>, pick: (e: unknown) => string): Promise<string> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let out = ''
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try { out += pick(JSON.parse(payload)) } catch { /* keepalive or partial */ }
    }
  }
  return out
}

const MARK: Record<Outcome['kind'], string> = {
  pass: 'PASS  ', wrong: 'WRONG ', rejected: 'REJECT', error: 'ERR   ',
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const models = o.all || o.capabilities
    ? (await catalogue(o)).map((m) => m.id)
    : o.models
  if (models.length === 0) throw new Error('nothing to probe: pass --models or --all')
  const protocols = o.protocols.length > 0 ? o.protocols : PROTOCOLS

  if (o.capabilities) return await capabilityAudit(o, await catalogue(o))

  console.log(`seed ${o.seed} · ${models.length} model(s) × ${protocols.length} protocol(s)\n`)
  let failures = 0
  let seed = o.seed
  for (const model of models) {
    for (const protocol of protocols) {
      const r = await probe(o, protocol, model, seed++)
      if (r.kind !== 'pass') failures++
      const detail = r.kind === 'pass' ? r.answer : 'answer' in r ? r.answer : r.detail
      console.log(`${MARK[r.kind]}  ${protocol.padEnd(9)} → ${model.padEnd(24)} ${detail}`)
    }
  }
  console.log(`\n${models.length * protocols.length - failures}/${models.length * protocols.length} passed`)
  if (failures > 0) process.exitCode = 1
}

/**
 * Cross-checks each model's advertised `supports.vision` against what it
 * actually does. The two disagree often enough on legacy catalogue entries
 * that the flag can't be trusted on its own to gate a UI.
 */
async function capabilityAudit(o: Options, models: Array<{ id: string; visionClaim: boolean | null }>) {
  console.log(`seed ${o.seed} · auditing ${models.length} model(s) on the openai protocol\n`)
  const disagreements: string[] = []
  let seed = o.seed
  for (const m of models) {
    const r = await probe(o, 'openai', m.id, seed++)
    // `wrong` means it answered but misread — vision is present either way.
    const actual = r.kind === 'rejected' ? false : r.kind === 'error' ? null : true
    const agree = actual === null ? null : actual === m.visionClaim
    const line = `${m.id.padEnd(24)} claim=${String(m.visionClaim).padEnd(5)} actual=${String(actual).padEnd(5)} ${MARK[r.kind]}`
    if (agree === false) disagreements.push(line)
    console.log(`${agree === false ? '!!' : '  '} ${line}`)
  }
  console.log(`\n${disagreements.length} disagreement(s)`)
  for (const d of disagreements) console.log(`  ${d}`)
}

await main()
