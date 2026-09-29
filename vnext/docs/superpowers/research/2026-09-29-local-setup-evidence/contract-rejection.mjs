import assert from 'node:assert/strict'
const root = process.env.VNEXT_PROBE_ROOT
assert(root?.startsWith('/'))
const { canonicalJson, sha256, validateEnvelope } = await import(`${root}/vnext/packages/setup-local/src/contract.ts`)
const { planSetup } = await import(`${root}/vnext/packages/setup-local/src/planner.ts`)
const origin = 'https://fixture.invalid'
const codex = { version: 1, client: 'codex', platform: 'posix', artifact: { kind: 'codex-config', config: { model_provider: 'copilot_gateway', model_providers: { copilot_gateway: { name: 'Copilot Gateway', base_url: origin + '/azure-api.codex/', wire_api: 'responses', supports_websockets: true } } }, credential: { kind: 'gateway-api-key', value: '1'.repeat(64) } } }
const claude = { version: 1, client: 'claude', platform: 'posix', artifact: { kind: 'claude-settings', settings: { env: { ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: '1'.repeat(64) } } } }
const cases = [
  ['array client', { ...codex, client: ['codex'] }],
  ['array platform', { ...codex, platform: ['posix'] }],
  ['array effort', { ...claude, artifact: { ...claude.artifact, settings: { env: { ...claude.artifact.settings.env, ANTHROPIC_CUSTOM_HEADERS: 'x-copilot-reasoning-effort: high' }, effortLevel: ['high'] } } }],
  ['array custom headers', { ...claude, artifact: { ...claude.artifact, settings: { env: { ...claude.artifact.settings.env, ANTHROPIC_CUSTOM_HEADERS: ['anthropic-beta: context-1m-2025-08-07'] } } } }],
]
const results = []
for (const [name, body] of cases) {
  let rejected = false
  try { await validateEnvelope({ ...body, artifactDigest: await sha256(canonicalJson(body)) }, origin) } catch { rejected = true }
  results.push({ name, rejected })
}
const body = structuredClone(claude)
body.artifact.settings.env.ANTHROPIC_CUSTOM_HEADERS = 'anthropic-beta: context-1m-2025-08-07'
const privateMarker = 'synthetic-private-header-marker'
const original = new TextEncoder().encode(JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer ' + privateMarker } }))
const plan = await planSetup({ artifact: { ...body, artifactDigest: await sha256(canonicalJson(body)) }, currentFiles: [{ kind: 'claude-settings', bytes: original, expectedSha256: await sha256(original) }], installation: { allowedHome: '/tmp/d10b-pure-unused-home', bunExecutable: process.execPath, runnerBytes: new Uint8Array([1]) } })
results.push({ name: 'redacted previous custom header', rejected: !plan.redactedDiff.includes(privateMarker) })
console.log(JSON.stringify(results))
assert(results.every(result => result.rejected), 'Every non-string enum/header must fail despite a valid digest')
