// Draft only. Requires a separately started, isolated d10b-acceptance/fixture.ts.
// The argument is either its state.json or a log containing its one-line JSON state.
// This probe never exchanges a lease or touches a real client home.
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const { chromium } = await import(process.env.D10B_PLAYWRIGHT_MODULE ?? "/Users/zhangxian/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs")

const stateFile = process.argv[2]
assert(stateFile, "Pass the fixture state.json or captured fixture stdout JSON path")
const fixture = JSON.parse(readFileSync(stateFile, "utf8").trim())
const { origin, keyId, sessionToken, assignedSessionToken, expectedKey, directory } = fixture
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin), "Fixture must use a loopback origin")
assert(sessionToken?.startsWith("ses_") && assignedSessionToken?.startsWith("ses_"),
  "Fixture must provide owner and assigned-only ses_ sessions")
assert(keyId && expectedKey && directory, "Fixture key, synthetic credential and output directory are required")

const setupBase = `${origin}/api/keys/${encodeURIComponent(keyId)}/setup`
const previewUrl = `${setupBase}/preview`
const mintUrl = `${setupBase}/leases`
const MODEL_IDS = ["gpt-5.6-sol", "gpt-setup-fixture-other"]
const labels = {
  preview: /Preview managed fields|预览管理字段/,
  mint: /Create one-use token|创建一次性令牌/,
  revoke: /Revoke \/ start again|撤销 \/ 重新开始/,
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitUntil = async (predicate, label) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return
    await delay(50)
  }
  assert.fail(`Timed out waiting for ${label}`)
}
const sectionFor = page => page.getByRole("region", { name: /One-command local setup|一条命令配置本机/ })
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const leaseToken = /^stl_[0-9a-f]{64}$/
const requestUrls = []
const pageErrors = []
const outstandingLeases = new Map()

// Defer delivery to React after the real server has computed the response.
// Holding only the first matching response preserves real auth, revision and
// lease writes while making a late browser response deterministic.
async function holdOne(page, url) {
  let signalArrival
  let signalRelease
  const arrived = new Promise(resolve => { signalArrival = resolve })
  const releaseWait = new Promise(resolve => { signalRelease = resolve })
  const handler = async route => {
    const upstream = await route.fetch()
    const body = await upstream.json()
    signalArrival({ status: upstream.status(), body })
    await releaseWait
    await route.fulfill({ response: upstream })
    await page.unroute(url, handler)
  }
  await page.route(url, handler)
  return { arrived, release: () => signalRelease() }
}

const browser = await chromium.launch({ headless: true })
let owner
try {
  owner = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 } })
  await owner.addCookies([{ name: "session_token", value: sessionToken, domain: "127.0.0.1", path: "/" }])
  const initialState = await (await owner.request.get(`${origin}/__fixture/state`)).json()
  assert(Number.isInteger(initialState.exchanges) && Number.isInteger(initialState.outboundCalls), "Fixture counters are required")
  const page = await owner.newPage()
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("request", request => requestUrls.push(request.url()))
  await page.goto(`${origin}/dashboard#keys`, { waitUntil: "domcontentloaded" })
  await page.getByRole("row").filter({ hasText: "Setup Fixture Key" }).click()
  await page.getByRole("button", { name: "Codex", exact: true }).click()
  const section = sectionFor(page)
  await section.waitFor()
  const config = page.locator(".glass-card").filter({ has: section })
  const modelButton = () => config.locator("button:has(> span.truncate)").first()
  const selectedModel = async () => (await modelButton().innerText()).trim()
  const switchModel = async () => {
    const before = await selectedModel()
    const target = MODEL_IDS.find(id => id !== before)
    assert(target, `Could not find a second Codex model (selected: ${before})`)
    await modelButton().click()
    await config.getByRole("button", { name: target, exact: true }).and(config.locator("button:not([title])")).click()
    await waitUntil(async () => (await selectedModel()) === target, `model selection ${target}`)
    return { before, after: target }
  }
  const clickAndRead = async (button, url, status) => {
    const responsePromise = page.waitForResponse(response => response.url() === url && response.request().method() === "POST")
    await section.getByRole("button", { name: labels[button] }).click()
    const response = await responsePromise
    assert.equal(response.status(), status, `${button} HTTP status`)
    return response.json()
  }
  const preview = () => clickAndRead("preview", previewUrl, 200)
  const mint = async () => {
    const value = await clickAndRead("mint", mintUrl, 201)
    outstandingLeases.set(value.leaseId, value)
    return value
  }
  const revoke = async lease => {
    assert(uuid.test(lease.leaseId), "Revoke must use the separate lease UUID")
    const url = `${mintUrl}/${lease.leaseId}`
    const responsePromise = page.waitForResponse(response => response.url() === url && response.request().method() === "DELETE")
    await section.getByRole("button", { name: labels.revoke }).click()
    const response = await responsePromise
    assert.equal(response.status(), 200, "revoke HTTP status")
    assert.equal((await response.json()).ok, true)
    outstandingLeases.delete(lease.leaseId)
    await section.locator('input[type="password"]').waitFor({ state: "detached" })
    assert(!requestUrls.some(value => value.includes(lease.leaseToken)), "Lease bearer appeared in a request URL")
  }
  const assertRedacted = async value => {
    assert.equal(value.version, 1)
    assert.equal(value.client, "codex")
    assert.equal(value.platform, "posix")
    assert.match(value.artifactDigest, /^[0-9a-f]{64}$/)
    assert(Array.isArray(value.touchedKeys) && value.touchedKeys.length > 0)
    assert(!JSON.stringify(value).includes(expectedKey), "Preview response exposed the synthetic gateway key")
    await waitUntil(async () => (await section.innerText()).includes(value.artifactDigest), "preview digest in UI")
    assert(!(await section.innerText()).includes(expectedKey), "Setup panel displayed the gateway key")
  }
  const assertMinted = async lease => {
    assert(uuid.test(lease.leaseId))
    assert(leaseToken.test(lease.leaseToken))
    assert(Date.parse(lease.expiresAt) > Date.now())
    const tokenField = section.locator('input[type="password"]')
    await tokenField.waitFor()
    assert.equal(await tokenField.inputValue(), lease.leaseToken)
    const command = await section.locator("pre").last().innerText()
    assert(command.includes(`${origin}/setup/setup.sh`), "Wrapper command must use the fixed public asset")
    assert(!command.includes(expectedKey) && !command.includes(lease.leaseToken), "Wrapper command leaked a credential")
    assert(!/stl_[0-9a-f]{64}/.test(command), "Wrapper command embedded a bearer")
    assert(!requestUrls.some(value => value.includes(lease.leaseToken)), "Lease bearer appeared in a URL")
  }

  const catalog = await owner.request.get(`${origin}/api/models?keyId=${encodeURIComponent(keyId)}&dedupe=0`)
  assert.equal(catalog.status(), 200)
  const modelRows = (await catalog.json()).data
  for (const id of MODEL_IDS) assert(modelRows.some(row => row.id === id && row.supported_endpoints?.includes("/responses")), `Missing ${id} in fixture catalog`)
  await waitUntil(async () => MODEL_IDS.includes(await selectedModel()), "initial Codex model selection")

  const initialPreview = await preview()
  await assertRedacted(initialPreview)
  await section.screenshot({ path: join(directory, "setup-preview.png"), animations: "disabled" })
  const first = await mint()
  await assertMinted(first)
  await section.screenshot({ path: join(directory, "setup-minted.png"), animations: "disabled" })
  await section.getByRole("button", { name: labels.revoke }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, "setup-command-viewport.png"), animations: "disabled" })
  assert.equal(first.artifactDigest, initialPreview.artifactDigest)
  await revoke(first)
  const secondPreview = await preview()
  await assertRedacted(secondPreview)
  const second = await mint()
  await assertMinted(second)
  assert.notEqual(second.leaseToken, first.leaseToken, "Remint must issue a fresh bearer")
  await revoke(second)

  // A stale preview must not enable mint for a newly selected model.
  const heldPreview = await holdOne(page, previewUrl)
  await section.getByRole("button", { name: labels.preview }).click()
  const oldPreview = await heldPreview.arrived
  assert.equal(oldPreview.status, 200)
  const previewChange = await switchModel()
  heldPreview.release()
  await waitUntil(async () => await section.getByRole("button", { name: labels.preview }).isEnabled(), "stale preview settled")
  assert.equal(await section.getByRole("button", { name: labels.mint }).count(), 0,
    "Old preview enabled mint for the newly selected model")
  assert(!(await section.innerText()).includes(oldPreview.body.artifactDigest), "Old preview digest survived model change")

  // A late real mint creates a lease. UI must identify it as belonging to the
  // old selection, retain its UUID for revoke, and never label it as the new one.
  const currentPreview = await preview()
  await assertRedacted(currentPreview)
  const beforeMintModel = await selectedModel()
  const heldMint = await holdOne(page, mintUrl)
  await section.getByRole("button", { name: labels.mint }).click()
  const oldMint = await heldMint.arrived
  assert.equal(oldMint.status, 201)
  const oldLease = oldMint.body
  outstandingLeases.set(oldLease.leaseId, oldLease)
  assert(uuid.test(oldLease.leaseId) && leaseToken.test(oldLease.leaseToken))
  const mintChange = await switchModel()
  assert.equal(mintChange.before, beforeMintModel)
  heldMint.release()
  await section.locator('input[type="password"]').waitFor()
  assert.equal(await section.locator('input[type="password"]').inputValue(), oldLease.leaseToken)
  const staleText = await section.innerText()
  assert(/selections changed while creating this token|创建令牌期间选择已变化/i.test(staleText), "Late mint lacks an explicit changed-selection warning")
  assert(staleText.includes(beforeMintModel), "Late mint lost the model it actually minted")
  assert(!staleText.includes(oldLease.leaseToken), "Bearer leaked into visible prose")
  await revoke(oldLease)
  const newPreview = await preview()
  await assertRedacted(newPreview)
  const newLease = await mint()
  await assertMinted(newLease)
  assert.notEqual(newLease.artifactDigest, oldLease.artifactDigest,
    "New selection should produce a different artifact digest")
  await revoke(newLease)

  // An assigned-only session can see the key but cannot reveal setup controls
  // or mint through the server's real session authorization path.
  const assigned = await browser.newContext({ locale: "en-US" })
  await assigned.addCookies([{ name: "session_token", value: assignedSessionToken, domain: "127.0.0.1", path: "/" }])
  const assignedPage = await assigned.newPage()
  assignedPage.on("pageerror", error => pageErrors.push(error.message))
  await assignedPage.goto(`${origin}/dashboard#keys`, { waitUntil: "domcontentloaded" })
  await assignedPage.getByRole("row").filter({ hasText: "Setup Fixture Key" }).click()
  await assignedPage.getByRole("button", { name: "Codex", exact: true }).click()
  await assignedPage.locator("pre code.language-toml").waitFor()
  assert.equal(await sectionFor(assignedPage).count(), 0, "Assigned-only viewer saw setup controls")
  const selection = { client: "codex", platform: "posix", settings: { model: MODEL_IDS[0] } }
  const assignedHeaders = { origin, "content-type": "application/json" }
  const assignedPreview = await assigned.request.post(previewUrl, { headers: assignedHeaders, data: selection })
  const assignedMint = await assigned.request.post(mintUrl, { headers: assignedHeaders,
    data: { ...selection, expectedConfigurationRevision: 0, expectedArtifactDigest: "0".repeat(64) } })
  assert.equal(assignedPreview.status(), 403)
  assert.equal(assignedMint.status(), 403)

  const state = await (await owner.request.get(`${origin}/__fixture/state`)).json()
  assert.equal(state.exchanges, initialState.exchanges, "Browser probe must not consume a lease")
  assert.equal(state.outboundCalls, initialState.outboundCalls, "Browser probe must not use external egress")
  assert.equal(state.keyInLogs, false)
  assert.equal(state.leaseInLogs, false)
  assert.equal(outstandingLeases.size, 0, "All browser-created leases must be revoked")
  assert.deepEqual(pageErrors, [])
  const result = { status: "passed", fixtureDirectory: directory, checks: [
    "owner preview redaction", "mint token-free static wrapper command", "revoke and remint",
    "late preview invalidation", "late mint scoped warning and revoke", "new selection remint",
    "assigned-only UI and API refusal", "no exchange or egress", "no browser errors",
  ], modelChanges: [previewChange, mintChange] }
  writeFileSync(join(directory, "browser-result.json"), JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify(result))
} finally {
  try {
    if (owner) {
      for (const lease of outstandingLeases.values()) {
        const response = await owner.request.delete(`${mintUrl}/${lease.leaseId}`, { headers: { origin } })
        assert.equal(response.status(), 200, "Emergency lease cleanup after an assertion failure")
      }
    }
  } finally {
    await browser.close()
  }
}
