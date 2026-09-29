/* global Bun */
// Independent real lease and process interruption acceptance; synthetic temp homes only.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, readdir, chmod, unlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'))
const root = process.env.VNEXT_PROBE_ROOT
assert(root?.startsWith('/'))
const { staticSetupCommand } = await import(`${root}/vnext/apps/dashboard/src/tabs/keys/setup-state.ts`)
const directory = await mkdtemp(join(tmpdir(), 'd10b-root-failures-'))
const runner = Buffer.from(await (await fetch(fixture.origin + '/setup/runner.mjs')).arrayBuffer())
const runnerPath = join(directory, 'runner.mjs')
await writeFile(runnerPath, runner, { mode: 0o600 })
const results = []
function env(home, overrides = {}) {
  const value = { ...process.env, HOME: home, USERPROFILE: home }
  delete value.CODEX_HOME
  delete value.CLAUDE_CONFIG_DIR
  return { ...value, ...overrides }
}
function cli(home, args, input = '', overrides = {}) {
  return spawnSync(process.execPath, [runnerPath, ...args], { env: env(home, overrides), input, encoding: 'utf8', timeout: 30_000 })
}
async function state() { return (await fetch(fixture.origin + '/__fixture/state')).json() }
async function lease(client = 'codex', platform = 'posix') {
  const selection = { client, platform, settings: { model: 'fixture-model' } }
  async function post(suffix, body) {
    const response = await fetch(`${fixture.origin}/api/keys/${fixture.keyId}/setup/${suffix}`, { method: 'POST', headers: { authorization: `Bearer ${fixture.sessionToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, suffix === 'leases' ? 201 : 200)
    return response.json()
  }
  const preview = await post('preview', selection)
  return post('leases', { ...selection, expectedConfigurationRevision: preview.configurationRevision, expectedArtifactDigest: preview.artifactDigest })
}
const args = ['setup', '--origin', fixture.origin, '--platform', 'posix']
for (const mode of ['direct', 'posix', 'powershell']) {
  const home = await mkdtemp(join(directory, 'custom-'))
  const minted = await lease('codex', mode === 'powershell' ? 'windows' : 'posix')
  const before = await state()
  let result
  const input = `${minted.leaseToken}\nAPPLY\n`
  const overrides = { CODEX_HOME: join(home, 'custom-codex') }
  if (mode === 'direct') result = cli(home, args, input, overrides)
  else {
    const name = mode === 'posix' ? 'setup.sh' : 'setup.ps1'
    const path = join(directory, name)
    await writeFile(path, await (await fetch(fixture.origin + '/setup/' + name)).text(), { mode: 0o600 })
    result = spawnSync(mode === 'posix' ? '/bin/sh' : '/usr/local/bin/pwsh', mode === 'posix' ? [path, '--origin', fixture.origin] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path, '-Origin', fixture.origin], { env: env(home, overrides), input, encoding: 'utf8', timeout: 30_000 })
  }
  assert.notEqual(result.status, 0, mode + ' custom home must fail')
  assert.equal((await state()).exchanges, before.exchanges)
  // PowerShell itself may initialize its private XDG cache/profile directories.
  assert.deepEqual((await readdir(home)).filter(name => mode !== 'powershell' || !['.local', '.cache'].includes(name)), [])
  const usable = await fetch(fixture.origin + '/api/setup/exchange', { method: 'POST', headers: { 'X-Setup-Lease': minted.leaseToken } })
  assert.equal(usable.status, 200, 'preflight must leave the real lease usable')
  results.push({ case: mode + '-custom-home-before-exchange', passed: true })
}
for (const platform of ['posix', 'windows']) for (const scenario of ['cancel', 'missing-bun']) {
  const home = await mkdtemp(join(directory, 'copied-command-'))
  const temporary = await mkdtemp(join(directory, 'command-temp-'))
  const minted = await lease('codex', platform)
  const before = await state()
  const command = staticSetupCommand(fixture.origin, platform)
  const copied = spawnSync(platform === 'posix' ? '/bin/sh' : '/usr/local/bin/pwsh', platform === 'posix' ? ['-c', command] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    env: env(home, { TMPDIR: temporary, ...(scenario === 'missing-bun' ? { PATH: '/usr/bin:/bin' } : {}) }),
    input: `${minted.leaseToken}\nNO\n`, encoding: 'utf8', timeout: 30_000,
  })
  assert.notEqual(copied.status, 0, `${platform} copied command must preserve ${scenario} failure`)
  assert(!`${copied.stdout}${copied.stderr}`.includes(minted.leaseToken))
  assert(!`${copied.stdout}${copied.stderr}`.includes(fixture.expectedKey))
  assert.equal((await state()).exchanges - before.exchanges, scenario === 'cancel' ? 1 : 0)
  await assert.rejects(readFile(join(home, '.codex/config.toml')), { code: 'ENOENT' })
  assert(!(await readdir(temporary)).some(name => name.endsWith('.ps1') || name.startsWith('copilot-setup-')), 'Copied PowerShell command retains downloaded script')
  results.push({ case: `${platform}-copied-command-${scenario}`, passed: true })
}
for (const mode of ['dry-run', 'cancel', 'malformed']) {
  const home = await mkdtemp(join(directory, mode + '-'))
  if (mode === 'malformed') { await mkdir(join(home, '.codex')); await writeFile(join(home, '.codex/config.toml'), '[broken\n') }
  const minted = await lease()
  const result = cli(home, mode === 'dry-run' ? [...args, '--dry-run'] : args, `${minted.leaseToken}\nNO\n`)
  assert.equal(result.status, mode === 'dry-run' ? 0 : 1, result.stderr)
  assert(!result.stdout.includes(fixture.expectedKey))
  assert(!result.stderr.includes(minted.leaseToken))
  if (mode === 'malformed') assert.equal(await readFile(join(home, '.codex/config.toml'), 'utf8'), '[broken\n')
  else assert.deepEqual(await readdir(home), [])
  const replay = await fetch(fixture.origin + '/api/setup/exchange', { method: 'POST', headers: { 'X-Setup-Lease': minted.leaseToken } })
  assert.notEqual(replay.status, 200)
  results.push({ case: mode, passed: true })
}
// A killed OS process leaves its real lock and durable journal for a separate CLI recovery.
const childPath = join(directory, 'interrupt.ts')
await writeFile(childPath, `import {readFileSync,realpathSync} from 'node:fs';\nconst root=process.env.VNEXT_PROBE_ROOT;\nconst {planSetup}=await import(root+'/vnext/packages/setup-local/src/planner.ts');\nconst {executeSetup,readCurrentFiles}=await import(root+'/vnext/packages/setup-local/src/executor.ts');\nconst home=realpathSync(process.env.HOME!);\nconst artifact=JSON.parse(readFileSync(process.argv[2],'utf8'));\nconst plan=await planSetup({artifact,currentFiles:readCurrentFiles(home,'codex'),installation:{allowedHome:home,bunExecutable:realpathSync(process.execPath),runnerBytes:readFileSync(process.argv[3])}});\nawait executeSetup({allowedHome:home,plan,io:{beforeRename(kind){if(kind==='codex-token')process.kill(process.pid,'SIGKILL')}}});\n`)
for (const conflict of [false, true]) {
  const home = await mkdtemp(join(directory, 'killed-'))
  await mkdir(join(home, '.codex'))
  const original = '# original config\nmodel = "native"\n'
  await writeFile(join(home, '.codex/config.toml'), original, { mode: 0o640 })
  const minted = await lease()
  const envelope = await (await fetch(fixture.origin + '/api/setup/exchange', { method: 'POST', headers: { 'X-Setup-Lease': minted.leaseToken } })).json()
  const envelopePath = join(directory, `private-envelope-${conflict}.json`)
  await writeFile(envelopePath, JSON.stringify(envelope), { mode: 0o600 })
  const killed = spawnSync(process.execPath, [childPath, envelopePath, runnerPath], { env: env(home), encoding: 'utf8', timeout: 30_000 })
  assert.equal(killed.signal, 'SIGKILL', killed.stderr)
  const installedRunner = join(home, '.codex/copilot-gateway/runner.mjs')
  assert.equal((await readFile(installedRunner)).length, runner.length)
  if (conflict) await writeFile(installedRunner, '// external edit\n')
  const recovered = cli(home, ['recover', 'codex'])
  assert.equal(recovered.status, conflict ? 1 : 0, recovered.stderr)
  assert.equal(await readFile(join(home, '.codex/config.toml'), 'utf8'), original)
  if (conflict) assert.equal(await readFile(installedRunner, 'utf8'), '// external edit\n')
  else await assert.rejects(readFile(installedRunner), { code: 'ENOENT' })
  const cleanup = cli(home, ['cleanup', 'codex'])
  assert.equal(cleanup.status, conflict ? 1 : 0, cleanup.stderr)
  results.push({ case: conflict ? 'sigkill-recovery-preserves-concurrent-edit' : 'sigkill-recovery-cleanup', passed: true })
}
const home = await mkdtemp(join(directory, 'helper-'))
const minted = await lease()
assert.equal(cli(home, args, `${minted.leaseToken}\nAPPLY\n`).status, 0)
const config = Bun.TOML.parse(await readFile(join(home, '.codex/config.toml'), 'utf8'))
const auth = config.model_providers.copilot_gateway.auth
const helper = () => spawnSync(auth.command, auth.args, { env: env(home), encoding: 'utf8', timeout: 10_000 })
assert.equal(helper().stdout.trim(), fixture.expectedKey)
await chmod(auth.args[2], 0o644)
assert.notEqual(helper().status, 0)
await chmod(auth.args[2], 0o600)
await unlink(auth.args[2])
assert.notEqual(helper().status, 0)
await unlink(auth.args[0])
assert.notEqual(helper().status, 0)
results.push({ case: 'helper-fails-closed', passed: true })
const finalState = await state()
assert.equal(finalState.outboundCalls, 0)
assert.equal(finalState.keyInLogs, false)
assert.equal(finalState.leaseInLogs, false)
await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify({ directory, results }))
