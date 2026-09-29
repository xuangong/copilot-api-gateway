/* global Bun */
// Independent actual lease -> static runner -> temporary client homes probe.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const statePath = process.argv[2]
assert(statePath, 'Pass the owned fixture state.json path')
const fixture = JSON.parse(await readFile(statePath, 'utf8'))
const runDirectory = await mkdtemp(join(tmpdir(), 'd10b-root-acceptance-'))
const runnerResponse = await fetch(`${fixture.origin}/setup/runner.mjs`)
assert.equal(runnerResponse.status, 200)
const runner = Buffer.from(await runnerResponse.arrayBuffer())
const checksum = (await (await fetch(`${fixture.origin}/setup/runner.sha256`)).text()).trim().split(/\s+/)[0]
assert.equal(createHash('sha256').update(runner).digest('hex'), checksum)
const runnerPath = join(runDirectory, 'runner.mjs')
await writeFile(runnerPath, runner, { mode: 0o600 })
async function lease(client, platform = 'posix') {
  const model = 'mapped-模型-"quoted"\nline'
  const selection = { client, platform, settings: { model } }
  const request = async (suffix, body) => {
    const response = await fetch(`${fixture.origin}/api/keys/${fixture.keyId}/setup/${suffix}`, {
      method: 'POST', headers: { authorization: `Bearer ${fixture.sessionToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert(response.ok, `setup ${suffix} failed: ${response.status}`)
    return response.json()
  }
  const preview = await request('preview', selection)
  assert(!JSON.stringify(preview).includes(fixture.expectedKey))
  const minted = await request('leases', { ...selection, expectedConfigurationRevision: preview.configurationRevision, expectedArtifactDigest: preview.artifactDigest })
  return { ...minted, model, preview }
}
function environment(home, additions = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...additions }
  delete env.CODEX_HOME
  delete env.CLAUDE_CONFIG_DIR
  return env
}
function invoke(args, env, input = '') {
  return spawnSync(process.execPath, [runnerPath, ...args], { env, input, encoding: 'utf8', timeout: 30_000 })
}
const wrapperMode = process.env.D10B_WRAPPER ?? 'direct'
assert(['direct', 'posix', 'powershell'].includes(wrapperMode))
let wrapperPath
if (wrapperMode !== 'direct') {
  const asset = wrapperMode === 'posix' ? 'setup.sh' : 'setup.ps1'
  const response = await fetch(`${fixture.origin}/setup/${asset}`)
  assert.equal(response.status, 200)
  const body = await response.text()
  assert(!body.includes('__RUNNER_SHA256__'))
  assert(!body.includes(fixture.expectedKey))
  wrapperPath = join(runDirectory, asset)
  await writeFile(wrapperPath, body, { mode: 0o600 })
}
const results = []
for (const client of ['claude', 'codex']) {
  const home = await mkdtemp(join(runDirectory, `${client}-`))
  const folder = join(home, client === 'codex' ? '.codex' : '.claude')
  await mkdir(folder)
  const original = client === 'codex' ? '# keep this comment\nmodel = "old"\nmodel_provider = "native"\n\n[features]\nweb_search = true # preserve\n\n[model_providers.other]\nname = "Other"\nbase_url = "https://unrelated.invalid/v1"\n' : JSON.stringify({ theme: 'dark', effortLevel: 'low', env: { UNRELATED: 'preserve', ANTHROPIC_DEFAULT_OPUS_MODEL: 'existing-opus' } }, null, 2)
  const configPath = join(folder, client === 'codex' ? 'config.toml' : 'settings.json')
  await writeFile(configPath, original, { mode: 0o600 })
  const authPath = join(folder, 'auth.json')
  const authOriginal = '{"unrelated_native_account":"never-read-or-write"}\n'
  await writeFile(authPath, authOriginal, { mode: 0o600 })
  const platform = wrapperMode === 'powershell' ? 'windows' : 'posix'
  const minted = await lease(client, platform)
  const input = `${minted.leaseToken}\nAPPLY\n`
  const result = wrapperMode === 'direct' ? invoke(['setup', '--origin', fixture.origin, '--platform', platform], environment(home), input)
    : spawnSync(wrapperMode === 'posix' ? '/bin/sh' : '/usr/local/bin/pwsh', wrapperMode === 'posix'
      ? [wrapperPath, '--origin', fixture.origin] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapperPath, '-Origin', fixture.origin],
      { env: environment(home), input, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, `setup ${client}: ${result.stderr}`)
  assert(!`${result.stdout}${result.stderr}`.includes(fixture.expectedKey), 'setup output leaked gateway credential')
  assert(!`${result.stdout}${result.stderr}`.includes(minted.leaseToken), 'setup output leaked lease')
  assert.equal(await readFile(authPath, 'utf8'), authOriginal)
  const written = await readFile(configPath, 'utf8')
  if (client === 'claude') {
    const value = JSON.parse(written)
    assert.equal(value.theme, 'dark')
    assert.equal(value.effortLevel, 'low', 'unset effort preserves existing local value')
    assert.equal(value.env.UNRELATED, 'preserve')
    assert.equal(value.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'existing-opus')
    assert.equal(value.env.ANTHROPIC_MODEL, minted.model)
    assert.equal(value.env.ANTHROPIC_AUTH_TOKEN, fixture.expectedKey)
    assert.equal(value.env.ANTHROPIC_CUSTOM_HEADERS, undefined)
  } else {
    const value = Bun.TOML.parse(written)
    assert(written.includes('# keep this comment'))
    assert(written.includes('web_search = true # preserve'))
    assert.equal(value.features.web_search, true)
    assert.equal(value.model_providers.other.base_url, 'https://unrelated.invalid/v1')
    assert.equal(value.model, minted.model)
    const provider = value.model_providers.copilot_gateway
    assert.equal(provider.supports_websockets, true)
    assert.equal(provider.base_url, `${fixture.origin}/azure-api.codex/`)
    assert.equal(provider.wire_api, 'responses')
    assert.equal(provider.auth.command, await realpath(process.execPath))
    const helper = spawnSync(provider.auth.command, provider.auth.args, { env: environment(home), encoding: 'utf8', timeout: 10_000 })
    assert.equal(helper.status, 0)
    assert.equal(helper.stdout.trim(), fixture.expectedKey)
    assert.equal(helper.stderr, '')
    assert.equal((await stat(join(folder, 'copilot-gateway-token'))).mode & 0o777, 0o600)
  }
  const state = await (await fetch(`${fixture.origin}/__fixture/state`)).json()
  assert.equal(state.outboundCalls, 0)
  assert.equal(state.keyInLogs, false)
  assert.equal(state.leaseInLogs, false)
  results.push({ client, wrapperMode, passed: true, home })
}
await writeFile(join(runDirectory, 'results.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify({ runDirectory, results }))
