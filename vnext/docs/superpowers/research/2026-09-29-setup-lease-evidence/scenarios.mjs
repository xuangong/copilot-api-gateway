import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const identities = {
  owner: { id: 'd10-owner', email: 'd10-owner@example.invalid', session: 'ses_d10_owner' },
  assigned: { id: 'd10-assigned', email: 'd10-assigned@example.invalid', session: 'ses_d10_assigned' },
  foreign: { id: 'd10-foreign', email: 'd10-foreign@example.invalid', session: 'ses_d10_foreign' },
  admin: { id: 'd10-admin', email: 'test@local.dev', session: 'ses_d10_admin' },
}
const keyId = 'd10-owned-key'
const ownerlessKeyId = 'd10-ownerless-key'
const rawKey = 'sk_d10_synthetic_fixture_only_001'
const ownerlessRawKey = 'sk_d10_synthetic_fixture_only_002'
const legacyUserKey = 'd10_legacy_user_key_only'
const upstreamSecret = 'd10_upstream_oauth_must_never_appear'

const asText = value => typeof value === 'string' ? value : JSON.stringify(value)
const expectClientDenial = result => {
  assert(result.status >= 400 && result.status < 500, `expected client denial, got ${result.status}`)
  assert.equal(result.headers.get('cache-control'), 'no-store', 'error response must not cache setup metadata')
}
const websocketFlag = value => {
  const found = []
  const visit = current => {
    if (!current || typeof current !== 'object') return
    for (const [key, child] of Object.entries(current)) {
      if (key === 'supports_websockets' || key === 'supportsWebsockets') found.push(child)
      visit(child)
    }
  }
  visit(value)
  assert.equal(found.length, 1, 'Codex artifact must expose exactly one effective WebSocket boolean')
  assert.equal(typeof found[0], 'boolean', 'Codex WebSocket capability must be boolean')
  return found[0]
}
const allValues = value => {
  const found = []
  const visit = current => {
    if (Array.isArray(current)) { for (const child of current) visit(child); return }
    if (!current || typeof current !== 'object') { found.push(current); return }
    for (const child of Object.values(current)) visit(child)
  }
  visit(value)
  return found
}
const assertSelectionProjection = (artifact, selection) => {
  if (selection.client === 'claude' && process.env.D10A_EXPECT_UNSET_EFFORT === '1') {
    const visit = current => {
      if (!current || typeof current !== 'object') return
      for (const [key, child] of Object.entries(current)) {
        if (/effort/i.test(key)) assert(child === null || child === '', 'unselected Claude effort was invented')
        visit(child)
      }
    }
    visit(artifact)
  }
  if (process.env.D10A_EXPECT_OPAQUE_MODEL) {
    assert(allValues(artifact).includes(process.env.D10A_EXPECT_OPAQUE_MODEL), 'opaque mapped model ID was decomposed')
  }
}
const noSecrets = (result, extra = []) => {
  for (const secret of [rawKey, ownerlessRawKey, upstreamSecret, ...extra]) {
    assert(!result.text.includes(secret), 'secret appeared in public response')
  }
}

export async function runD10AAcceptance({ dispatch, directDispatch, sql, selection, expectedWebsockets, scanLogs = async () => '', runtime, fixtureOrigin = 'http://d10.fixture.invalid', atomicConsume }) {
  assert(selection && typeof selection === 'object' && !Array.isArray(selection), 'D10A_SELECTION_JSON must be an object')
  assert(['claude', 'codex'].includes(selection.client), 'selection.client required')
  assert(['posix', 'windows'].includes(selection.platform), 'selection.platform required')
  assert(selection.settings && typeof selection.settings === 'object', 'selection.settings required')
  const revokeTemplate = process.env.D10A_REVOKE_PATH_TEMPLATE
  assert(revokeTemplate?.startsWith('/') && revokeTemplate.includes('{keyId}') && revokeTemplate.includes('{leaseId}'), 'D10A_REVOKE_PATH_TEMPLATE required for full acceptance')
  const origin = fixtureOrigin
  const allUrls = []
  const leaseTokens = []
  let initialDigest
  const call = async ({ path, method = 'POST', body, session = 'owner', auth = 'bearer', headers: added = {} }) => {
    assert(path.startsWith('/') && !path.includes(rawKey) && !path.includes(ownerlessRawKey), 'credential in URL')
    allUrls.push(path)
    const headers = { ...added }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (session && auth === 'bearer') headers.authorization = `Bearer ${identities[session]?.session ?? session}`
    if (session && (auth === 'cookie' || auth === 'cookie-no-origin')) {
      headers.cookie = `session_token=${identities[session]?.session ?? session}`
      if (auth === 'cookie' && !('origin' in headers)) headers.origin = origin
    }
    if (auth === 'legacy') headers.authorization = `Bearer ${legacyUserKey}`
    if (auth === 'api-key') headers.authorization = `Bearer ${rawKey}`
    const response = await dispatch(new Request(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }))
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* malformed response fails at field assertions */ }
    return { status: response.status, text, json, headers: response.headers }
  }
  const preview = (id = keyId, overrides = {}) => call({ path: `/api/keys/${id}/setup/preview`, body: selection, ...overrides })
  const mint = async (id = keyId, overrides = {}) => {
    const prior = await preview(id, overrides)
    assert.equal(prior.status, 200, `preview status ${prior.status}`)
    assert.equal(prior.headers.get('cache-control'), 'no-store')
    noSecrets(prior)
    assert(typeof prior.json?.configurationRevision === 'number', 'preview revision missing')
    assert(typeof prior.json?.artifactDigest === 'string', 'preview digest missing')
    if (selection.client === 'codex') assert.equal(websocketFlag(prior.json.redactedArtifact), expectedWebsockets)
    assertSelectionProjection(prior.json.redactedArtifact, selection)
    if (!initialDigest && id === keyId) initialDigest = prior.json.artifactDigest
    const created = await call({
      path: `/api/keys/${id}/setup/leases`,
      body: { ...selection, expectedConfigurationRevision: prior.json.configurationRevision, expectedArtifactDigest: prior.json.artifactDigest },
      ...overrides,
    })
    assert(created.status >= 200 && created.status < 300, `mint status ${created.status}`)
    assert.equal(created.headers.get('cache-control'), 'no-store')
    noSecrets(created)
    assert(typeof created.json?.leaseToken === 'string' && created.json.leaseToken.length >= 32, 'lease bearer missing')
    assert(typeof created.json?.leaseId === 'string' && /^[0-9a-f-]{36}$/i.test(created.json.leaseId), 'independent leaseId missing')
    assert.notEqual(created.json.leaseId, created.json.leaseToken)
    assert.equal(created.json.artifactDigest, prior.json.artifactDigest)
    assert.equal(await readRevision(), prior.json.configurationRevision, 'mint changed global configuration revision')
    leaseTokens.push(created.json.leaseToken)
    return created.json
  }
  const exchange = token => call({ path: '/api/setup/exchange', session: null, headers: { 'X-Setup-Lease': token } })
  const readRevision = async () => (await sql.first('SELECT revision FROM configuration_revision WHERE id = 1', [])).revision
  const changeWithoutRevision = async (statement, binds) => {
    const previous = await readRevision()
    await sql.run(statement, binds)
    await sql.run('UPDATE configuration_revision SET revision = ? WHERE id = 1', [previous])
  }

  // Fresh, isolated identities; none corresponds to a live user or credential.
  const now = new Date().toISOString()
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const past = new Date(Date.now() - 3_600_000).toISOString()
  for (const [role, user] of Object.entries(identities)) {
    await sql.run('INSERT INTO users(id,name,email,created_at,user_key) VALUES(?,?,?,?,?)', [user.id, role, user.email, now, role === 'owner' ? legacyUserKey : null])
    await sql.run('INSERT INTO user_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)', [user.session, user.id, now, future])
  }
  await sql.run('INSERT INTO user_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)', ['ses_d10_expired', identities.owner.id, past, past])
  await sql.run('INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)', [keyId, 'D10 synthetic owned', rawKey, now, identities.owner.id])
  await sql.run('INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)', [ownerlessKeyId, 'D10 synthetic ownerless', ownerlessRawKey, now, null])
  await sql.run('INSERT INTO key_assignments(key_id,user_id,assigned_by,assigned_at) VALUES(?,?,?,?)', [keyId, identities.assigned.id, identities.owner.id, now])
  await sql.run('INSERT INTO upstreams(id,owner_id,provider,name,config_json,state_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [
    'd10-upstream', identities.owner.id, 'codex', 'D10 synthetic upstream', '{}', JSON.stringify({ oauthSecret: upstreamSecret }), now, now,
  ])

  for (const result of [
    await preview(keyId, { session: 'assigned' }),
    await preview(keyId, { session: 'foreign' }),
    await preview(ownerlessKeyId, { session: 'owner' }),
    await preview(keyId, { session: null }),
    await preview(keyId, { session: 'ses_d10_expired' }),
    await preview(keyId, { auth: 'legacy' }),
    await preview(keyId, { auth: 'api-key' }),
    await preview(keyId, { path: `/api/keys/${keyId}/setup/preview?key=${identities.owner.session}`, session: null }),
    await preview(keyId, { auth: 'cookie', headers: { origin: 'http://wrong.fixture.invalid' } }),
  ]) { expectClientDenial(result); noSecrets(result) }
  const cookieWithoutOrigin = await call({ path: `/api/keys/${keyId}/setup/preview`, body: selection, session: 'owner', auth: 'cookie-no-origin' })
  expectClientDenial(cookieWithoutOrigin)
  const cookiePreview = await preview(keyId, { auth: 'cookie' })
  assert.equal(cookiePreview.status, 200, `cookie preview: ${cookiePreview.text}`)
  assert.equal((await preview(keyId, { session: 'admin' })).status, 200)
  assert.equal((await preview(ownerlessKeyId, { session: 'admin' })).status, 200)
  const deniedMint = await call({ path: `/api/keys/${keyId}/setup/leases`, body: { ...selection, expectedConfigurationRevision: await readRevision(), expectedArtifactDigest: '0'.repeat(64) }, session: 'assigned' })
  expectClientDenial(deniedMint)
  const stalePreview = await preview()
  assert.equal(stalePreview.status, 200)
  const staleMint = await call({ path: `/api/keys/${keyId}/setup/leases`, body: { ...selection, expectedConfigurationRevision: stalePreview.json.configurationRevision + 1, expectedArtifactDigest: stalePreview.json.artifactDigest } })
  expectClientDenial(staleMint); noSecrets(staleMint)
  const wrongDigestMint = await call({ path: `/api/keys/${keyId}/setup/leases`, body: { ...selection, expectedConfigurationRevision: stalePreview.json.configurationRevision, expectedArtifactDigest: '0'.repeat(64) } })
  expectClientDenial(wrongDigestMint); noSecrets(wrongDigestMint)

  for (const badSelection of [
    { ...selection, baseUrl: 'https://attacker.invalid' },
    { ...selection, settings: { ...selection.settings, command: 'echo forbidden' } },
    { ...selection, settings: { model: '' } },
    { ...selection, settings: { model: 'nul\u0000model' } },
    { ...selection, settings: { model: 'x'.repeat(1025) } },
  ]) {
    const result = await preview(keyId, { body: badSelection })
    expectClientDenial(result); noSecrets(result)
  }
  const falseForwarded = await preview(keyId, { headers: { 'x-forwarded-host': 'attacker.invalid' } })
  expectClientDenial(falseForwarded); noSecrets(falseForwarded)
  const originUrl = new URL(origin)
  const canonicalForwarded = await preview(keyId, { headers: { 'x-forwarded-host': originUrl.host.toUpperCase(), 'x-forwarded-proto': originUrl.protocol.slice(0, -1).toUpperCase() } })
  assert.equal(canonicalForwarded.status, 200, 'equivalent case-normalized origin must remain same-origin')
  if (!originUrl.port) {
    const defaultPort = await preview(keyId, { headers: { 'x-forwarded-host': `${originUrl.hostname}:${originUrl.protocol === 'https:' ? 443 : 80}` } })
    assert.equal(defaultPort.status, 200, 'explicit default port must remain same-origin')
  }
  for (const suffix of ['/extra', '?extra=1', '#extra']) {
    const extraOriginParts = await preview(keyId, { headers: { 'x-forwarded-host': originUrl.host + suffix } })
    expectClientDenial(extraOriginParts); noSecrets(extraOriginParts)
  }
  const overBody = await preview(keyId, { body: { ...selection, unknown: 'x'.repeat(16384) } })
  assert.equal(overBody.status, 413, 'body must be bounded before schema decoding')
  expectClientDenial(overBody)
  const wrongMime = await dispatch(new Request(`${origin}/api/keys/${keyId}/setup/preview`, {
    method: 'POST', headers: { authorization: `Bearer ${identities.owner.session}`, 'content-type': 'text/plain' }, body: JSON.stringify(selection),
  }))
  assert.equal(wrongMime.status, 415)
  assert.equal(wrongMime.headers.get('cache-control'), 'no-store')

  const firstLease = await mint()
  const persisted = await sql.first('SELECT * FROM setup_leases WHERE id = ?', [firstLease.leaseId])
  assert(persisted, 'mint did not persist lease')
  assert(!asText(persisted).includes(firstLease.leaseToken), 'plaintext lease persisted')
  assert(!asText(persisted).includes(rawKey), 'plaintext gateway key persisted')
  assert.equal(persisted.token_hash.length, 64)
  assert.match(firstLease.leaseToken, /^stl_[a-f0-9]{64}$/)
  assert.equal(persisted.token_hash, createHash('sha256').update(Buffer.from(firstLease.leaseToken.slice(4), 'hex')).digest('hex'))
  const forbiddenExchangeBody = await call({ path: '/api/setup/exchange', session: null, headers: { 'X-Setup-Lease': firstLease.leaseToken }, body: { keyId: ownerlessKeyId } })
  expectClientDenial(forbiddenExchangeBody); noSecrets(forbiddenExchangeBody, [firstLease.leaseToken])
  assert.equal(forbiddenExchangeBody.headers.get('referrer-policy'), 'no-referrer')
  const redeemed = await exchange(firstLease.leaseToken)
  assert.equal(redeemed.status, 200, `exchange status ${redeemed.status}`)
  assert.equal(redeemed.headers.get('cache-control'), 'no-store')
  assert.equal(redeemed.headers.get('referrer-policy'), 'no-referrer')
  assert(redeemed.text.includes(rawKey), 'exchange did not return selected gateway credential')
  if (selection.client === 'codex') assert.equal(websocketFlag(redeemed.json?.artifact), expectedWebsockets)
  assertSelectionProjection(redeemed.json?.artifact, selection)
  assert(!redeemed.text.includes(upstreamSecret), 'exchange returned upstream credential')
  assert(!redeemed.text.includes(firstLease.leaseToken), 'exchange echoed lease')
  const replay = await exchange(firstLease.leaseToken)
  expectClientDenial(replay); noSecrets(replay, [firstLease.leaseToken])

  const concurrent = await mint()
  const contenders = await Promise.all([exchange(concurrent.leaseToken), exchange(concurrent.leaseToken)])
  assert.equal(contenders.filter(r => r.status === 200).length, 1, 'two redeemers won one lease')
  for (const rejected of contenders.filter(r => r.status !== 200)) { expectClientDenial(rejected); noSecrets(rejected, [concurrent.leaseToken]) }
  const row = await sql.first('SELECT consumed_at FROM setup_leases WHERE id = ?', [concurrent.leaseId])
  assert(row?.consumed_at, 'winning exchange did not consume lease')

  assert.equal(typeof atomicConsume, 'function', 'real repository atomic-consume seam required')
  const atomicCases = [
    { name: 'rotated-key', statement: 'UPDATE api_keys SET key = ? WHERE id = ?', binds: ['sk_d10_raced_key', keyId], restore: ['UPDATE api_keys SET key = ? WHERE id = ?', [rawKey, keyId]] },
    { name: 'owner-change', statement: 'UPDATE api_keys SET owner_id = ? WHERE id = ?', binds: [identities.foreign.id, keyId], restore: ['UPDATE api_keys SET owner_id = ? WHERE id = ?', [identities.owner.id, keyId]] },
    { name: 'disabled-minter', statement: 'UPDATE users SET disabled = 1 WHERE id = ?', binds: [identities.owner.id], restore: ['UPDATE users SET disabled = 0 WHERE id = ?', [identities.owner.id]] },
    { name: 'revoked-between-read-and-consume', statement: 'UPDATE setup_leases SET revoked_at = ? WHERE id = ?', binds: [now, '$lease'], restore: null },
    { name: 'global-revision', statement: 'UPDATE configuration_revision SET revision = revision + 1 WHERE id = 1', binds: [], preserveRevision: false, restore: null },
    { name: 'admin-demoted', key: ownerlessKeyId, session: 'admin', statement: 'UPDATE users SET email = ? WHERE id = ?', binds: ['d10-demoted@example.invalid', identities.admin.id], restore: ['UPDATE users SET email = ? WHERE id = ?', [identities.admin.email, identities.admin.id]] },
    { name: 'admin-key-owner-disabled', session: 'admin', statement: 'UPDATE users SET disabled = 1 WHERE id = ?', binds: [identities.owner.id], restore: ['UPDATE users SET disabled = 0 WHERE id = ?', [identities.owner.id]] },
  ]
  for (const item of atomicCases) {
    const lease = await mint(item.key ?? keyId, { session: item.session ?? 'owner' })
    const result = await atomicConsume({ leaseId: lease.leaseId, statement: item.statement,
      binds: item.binds.map(value => value === '$lease' ? lease.leaseId : value), preserveRevision: item.preserveRevision !== false })
    assert.equal(result.consumed, false, `${item.name} mutation after pre-read bypassed atomic SQL fence`)
    const persisted = await sql.first('SELECT consumed_at FROM setup_leases WHERE id = ?', [lease.leaseId])
    assert.equal(persisted.consumed_at, null, `${item.name} wrongly marked consumed`)
    if (item.restore) await sql.run(...item.restore)
  }

  const adminOwnerless = await mint(ownerlessKeyId, { session: 'admin' })
  const adminOwnerlessResult = await exchange(adminOwnerless.leaseToken)
  assert.equal(adminOwnerlessResult.status, 200, 'admin ownerless lease did not exchange')
  assert(adminOwnerlessResult.text.includes(ownerlessRawKey), 'ownerless exchange selected wrong key')
  assert(!adminOwnerlessResult.text.includes(rawKey), 'ownerless exchange included foreign key')

  if (selection.client === 'codex' && directDispatch) {
    const directCall = async (path, body) => {
      const response = await directDispatch(new Request(`${origin}${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${identities.owner.session}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      }))
      const text = await response.text()
      return { status: response.status, text, json: JSON.parse(text), headers: response.headers }
    }
    const directPreview = await directCall(`/api/keys/${keyId}/setup/preview`, selection)
    assert.equal(directPreview.status, 200, 'direct app preview failed')
    noSecrets(directPreview)
    assert.equal(websocketFlag(directPreview.json.redactedArtifact), false)
    assert.notEqual(directPreview.json.artifactDigest, initialDigest, 'installed-ingress capability omitted from artifact digest')
    const directMint = await directCall(`/api/keys/${keyId}/setup/leases`, {
      ...selection, expectedConfigurationRevision: directPreview.json.configurationRevision, expectedArtifactDigest: directPreview.json.artifactDigest,
    })
    assert(directMint.status >= 200 && directMint.status < 300, 'direct app mint failed')
    noSecrets(directMint)
    leaseTokens.push(directMint.json.leaseToken)
    const changedIngress = await exchange(directMint.json.leaseToken)
    expectClientDenial(changedIngress); noSecrets(changedIngress, [directMint.json.leaseToken])
  }

  const expired = await mint()
  await sql.run('UPDATE setup_leases SET expires_at = ? WHERE id = ?', [past, expired.leaseId])
  const expiredResult = await exchange(expired.leaseToken)
  expectClientDenial(expiredResult); noSecrets(expiredResult, [expired.leaseToken])

  const revised = await mint()
  await sql.run("UPDATE users SET name = name || '-revised' WHERE id = ?", [identities.foreign.id])
  const revisedResult = await exchange(revised.leaseToken)
  expectClientDenial(revisedResult); noSecrets(revisedResult, [revised.leaseToken])

  const tampered = await mint()
  await sql.run('UPDATE setup_leases SET artifact_digest = ? WHERE id = ?', ['0'.repeat(64), tampered.leaseId])
  const tamperedResult = await exchange(tampered.leaseToken)
  expectClientDenial(tamperedResult); noSecrets(tamperedResult, [tampered.leaseToken])

  const rotated = await mint()
  await changeWithoutRevision('UPDATE api_keys SET key = ? WHERE id = ?', ['sk_d10_synthetic_rotated', keyId])
  const rotatedResult = await exchange(rotated.leaseToken)
  expectClientDenial(rotatedResult); noSecrets(rotatedResult, [rotated.leaseToken])
  await sql.run('UPDATE api_keys SET key = ? WHERE id = ?', [rawKey, keyId])

  const disabledMinter = await mint()
  await changeWithoutRevision('UPDATE users SET disabled = 1 WHERE id = ?', [identities.owner.id])
  const disabledMinterResult = await exchange(disabledMinter.leaseToken)
  expectClientDenial(disabledMinterResult); noSecrets(disabledMinterResult, [disabledMinter.leaseToken])
  await sql.run('UPDATE users SET disabled = 0 WHERE id = ?', [identities.owner.id])

  const adminForOwner = await mint(keyId, { session: 'admin' })
  await changeWithoutRevision('UPDATE users SET disabled = 1 WHERE id = ?', [identities.owner.id])
  const disabledOwnerResult = await exchange(adminForOwner.leaseToken)
  expectClientDenial(disabledOwnerResult); noSecrets(disabledOwnerResult, [adminForOwner.leaseToken])
  await sql.run('UPDATE users SET disabled = 0 WHERE id = ?', [identities.owner.id])

  const revoked = await mint()
  const revokePath = revokeTemplate.replaceAll('{keyId}', keyId).replaceAll('{leaseId}', revoked.leaseId)
  assert(revokePath.includes(revoked.leaseId) && !revokePath.includes(revoked.leaseToken), 'revoke must address leaseId')
  const revoke = await call({ path: revokePath, method: 'DELETE' })
  assert(revoke.status >= 200 && revoke.status < 300, `revoke status ${revoke.status}`)
  const revokedResult = await exchange(revoked.leaseToken)
  expectClientDenial(revokedResult); noSecrets(revokedResult, [revoked.leaseToken])

  const noKey = await mint()
  await changeWithoutRevision('DELETE FROM api_keys WHERE id = ?', [keyId])
  const noKeyResult = await exchange(noKey.leaseToken)
  expectClientDenial(noKeyResult); noSecrets(noKeyResult, [noKey.leaseToken])
  const inference = await call({ path: '/v1/responses', body: { model: 'synthetic', input: 'fixture', stream: false }, session: null, headers: { authorization: `Bearer ${noKey.leaseToken}` } })
  assert.equal(inference.status, 401, 'lease must be explicitly rejected as inference credential')
  const keyList = await call({ path: '/api/keys', method: 'GET', session: null, headers: { authorization: `Bearer ${noKey.leaseToken}` } })
  assert.equal(keyList.status, 401, 'lease must be explicitly rejected by key-list route')
  assert(!keyList.text.includes(ownerlessRawKey) && !keyList.text.includes(ownerlessKeyId), 'lease authorized key-list route')

  // The single intentionally malformed ?key=ses_ request above is excluded
  // from this minted-bearer check; the server must reject it.
  for (const path of allUrls) assert(!path.includes('sk_d10_') && leaseTokens.every(token => !path.includes(token)), 'minted credential in request URL')
  const capturedLogs = await scanLogs([rawKey, ownerlessRawKey, upstreamSecret, ...leaseTokens])
  assert.equal(capturedLogs, '', 'credential appeared in captured application log')
  const result = { runtime, passed: true, selectionClient: selection.client, installedIngressWebsockets: selection.client === 'codex' ? expectedWebsockets : null, initialDigest, cases: ['real-session-auth', 'origin', 'admin-ownerless', 'redaction', 'one-use', 'concurrent-single-winner', 'expiry', 'revision', 'digest', 'rotation', 'minter-and-owner-disable', 'key-delete', 'cross-route-isolation', 'revoke', 'atomic-preread-fences-7', 'strict-schema-body-mime', 'forwarded-origin', 'exchange-body-rejection', ...(selection.client === 'codex' && directDispatch ? ['ingress-capability-mismatch'] : [])] }
  console.log(JSON.stringify(result))
  return result
}
