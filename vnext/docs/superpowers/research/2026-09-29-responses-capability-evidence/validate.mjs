// Independent isolated acceptance; build the selected dashboard first.
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import http from "node:http"
import { dirname, join } from "node:path"
import { chromium } from "/Users/zhangxian/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs"

const connectionFile = process.env.C12_CONNECTION
const booleanPointer = process.env.C12_CAPABILITY_BOOLEAN_POINTER
assert(connectionFile && booleanPointer?.startsWith("/"), "C12_CONNECTION and C12_CAPABILITY_BOOLEAN_POINTER are required")
const { origins, capabilityPath, sessionToken, apiKey, keyId, controlToken, sourceRoot } = JSON.parse(readFileSync(connectionFile, "utf8"))
const runDir = dirname(connectionFile)
const expectedModels = ["gpt-5.6-sol", "gpt-capability-unmatched-2026"]
const bundled = JSON.parse(readFileSync(join(sourceRoot, "packages/gateway/src/data-plane/codex/catalog/bundled.json"), "utf8"))
assert.equal(bundled.models.find(model => model.slug === expectedModels[0])?.prefer_websockets, true,
  "matched source catalog must provide a true value that direct Hono overrides")

function atPointer(value, pointer) {
  assert(pointer.startsWith("/"), `invalid JSON pointer: ${pointer}`)
  return pointer.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, key) => current?.[key], value)
}

const structuredAssertionsFile = process.env.C12_STRUCTURED_ASSERTIONS_FILE
const structuredAssertions = structuredAssertionsFile
  ? JSON.parse(readFileSync(structuredAssertionsFile, "utf8")) : []
assert(Array.isArray(structuredAssertions), "C12_STRUCTURED_ASSERTIONS_FILE must be a JSON array")
for (const entry of structuredAssertions) {
  assert.equal(typeof entry.pointer, "string")
  assert(entry.pointer.startsWith("/"))
  assert(Object.hasOwn(entry, "expected") || Object.hasOwn(entry, "expectedByOrigin"))
  if (Object.hasOwn(entry, "expectedByOrigin")) {
    assert(entry.expectedByOrigin && typeof entry.expectedByOrigin === "object")
    assert(Object.hasOwn(entry.expectedByOrigin, "native"))
    assert(Object.hasOwn(entry.expectedByOrigin, "direct"))
  }
}

const browser = await chromium.launch({ headless: true })
const pageErrors = []
const observed = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitUntil = async (predicate, label) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return
    await pause(50)
  }
  assert.fail(`timed out waiting for ${label}`)
}

function websocketHandshake(origin, key) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}/v1/responses`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${key}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      },
    })
    request.setTimeout(5000, () => request.destroy(new Error("WebSocket handshake timed out")))
    request.once("error", reject)
    request.once("upgrade", (response, socket) => {
      socket.destroy()
      resolve({ status: response.statusCode, headers: response.headers })
    })
    request.once("response", response => {
      response.resume()
      response.once("end", () => resolve({ status: response.statusCode, headers: response.headers }))
      response.once("error", reject)
    })
    request.end()
  })
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addCookies([{ name: "session_token", value: sessionToken, domain: "127.0.0.1", path: "/" }])
  const anonymous = await browser.newContext()
  const control = async command => {
    const response = await context.request.fetch(`${origins.native}/__fixture/${command}`, {
      method: command === "state" ? "GET" : "POST",
      headers: { "x-fixture-control": controlToken },
    })
    assert.equal(response.status(), 200, `fixture ${command}`)
    return response.json()
  }
  const readCapability = async (origin, request = context.request) => {
    const response = await request.get(`${origin}${capabilityPath}`)
    const body = await response.json()
    observed.push({ origin, status: response.status(), body })
    return { response, body }
  }
  const assertNoStore = response => assert.match(response.headers()["cache-control"] ?? "", /(?:^|,)\s*no-store\b/i)

  // HTTP policy and exact per-request ingress: the two origins share the app,
  // process and repo, but only one has an installed native upgrade adapter.
  const outboundBeforeCapability = (await control("state")).outboundCalls
  for (const [name, expected] of [["native", true], ["direct", false]]) {
    const { response, body } = await readCapability(origins[name])
    assert.equal(response.status(), 200, `${name} capability status`)
    assertNoStore(response)
    assert.equal(atPointer(body, booleanPointer), expected, `${name} capability value`)
    for (const entry of structuredAssertions) {
      const expectedValue = entry.expectedByOrigin ? entry.expectedByOrigin[name] : entry.expected
      assert.deepEqual(atPointer(body, entry.pointer), expectedValue, `${name} ${entry.pointer}`)
    }
    const unauthenticated = await readCapability(origins[name], anonymous.request)
    assert([401, 403].includes(unauthenticated.response.status()), `${name} unauthenticated read must be denied`)
    assert.notEqual(atPointer(unauthenticated.body, booleanPointer), true, `${name} unauthenticated read leaked true`)
  }
  const failedRead = await readCapability(origins.failedNative)
  assert.equal(failedRead.response.status(), 503)
  assertNoStore(failedRead.response)
  assert.equal((await control("state")).outboundCalls, outboundBeforeCapability,
    "capability reads must not discover or call an upstream")

  // Hold one native read while direct Hono and a second native request run in
  // the same process. This catches process-wide mutable capability flags.
  const reachedBefore = (await control("state")).held.reached
  await control("hold")
  const heldRead = readCapability(origins.native)
  await waitUntil(async () => (await control("state")).held.reached === reachedBefore + 1, "held native capability read")
  const [directDuringHold, nativeDuringHold] = await Promise.all([
    readCapability(origins.direct), readCapability(origins.native),
  ])
  assert.equal(atPointer(directDuringHold.body, booleanPointer), false)
  assert.equal(atPointer(nativeDuringHold.body, booleanPointer), true)
  await control("release")
  const releasedRead = await heldRead
  assert.equal(atPointer(releasedRead.body, booleanPointer), true)
  assert.equal((await control("state")).held.forwarded, reachedBefore + 1)

  const nativeUpgrade = await websocketHandshake(origins.native, apiKey)
  const directUpgrade = await websocketHandshake(origins.direct, apiKey)
  const failedUpgrade = await websocketHandshake(origins.failedNative, apiKey)
  assert.equal(nativeUpgrade.status, 101, "native Bun must accept a real authenticated upgrade")
  assert.equal(directUpgrade.status, 426, "direct Hono must retain its authenticated fallback")
  assert.equal(failedUpgrade.status, 101, "synthetic read failure must not remove the native upgrade")

  // Manual Custom models are served from the temporary repo. A Codex-shaped
  // catalog uses the bundled snapshot after the fixture blocks remote fetch.
  for (const [name, expected] of [["native", true], ["direct", false]]) {
    const publicCatalog = await context.request.get(`${origins[name]}/api/models?keyId=${encodeURIComponent(keyId)}&dedupe=0`)
    assert.equal(publicCatalog.status(), 200)
    const publicRows = (await publicCatalog.json()).data
    assert.deepEqual(expectedModels.map(id => publicRows.find(row => row.id === id)?.id), expectedModels)
    const codexCatalog = await context.request.get(`${origins[name]}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, "user-agent": "codex-tui/0.144.1" },
    })
    assert.equal(codexCatalog.status(), 200)
    const rows = (await codexCatalog.json()).models
    for (const id of expectedModels) {
      const row = rows.find(model => model.slug === id)
      assert(row, `${name} Codex catalog missing ${id}`)
      assert.equal(row.prefer_websockets, expected, `${name} ${id} ingress preference`)
    }
  }

  const page = await context.newPage()
  page.on("pageerror", error => pageErrors.push(error.message))
  const snippet = page.locator("pre code.language-toml")
  const openConfig = async origin => {
    await page.goto(`${origin}/dashboard#keys`, { waitUntil: "domcontentloaded" })
    await page.getByRole("row").filter({ hasText: "C12 Capability Key" }).click()
    await page.getByRole("button", { name: "Codex", exact: true }).click()
    await snippet.waitFor()
  }
  const waitForSnippet = async (value, origin) => {
    await waitUntil(async () => (await snippet.textContent())?.includes(`supports_websockets = ${value}`), `${origin} Codex TOML ${value}`)
    const text = await snippet.textContent()
    assert(text.includes(`base_url = "${origin}/"`), `${origin} snippet base URL`)
    return text
  }
  await openConfig(origins.native)
  const nativeSnippet = await waitForSnippet("true", origins.native)
  await page.screenshot({ path: join(runDir, "native-codex.png"), fullPage: true, animations: "disabled" })
  await openConfig(origins.direct)
  const directSnippet = await waitForSnippet("false", origins.direct)
  await page.screenshot({ path: join(runDir, "direct-codex.png"), fullPage: true, animations: "disabled" })
  await openConfig(origins.failedNative)
  const failedSnippet = await waitForSnippet("false", origins.failedNative)
  await page.screenshot({ path: join(runDir, "failed-codex.png"), fullPage: true, animations: "disabled" })

  // A pending old-origin read must never turn the new origin's snippet true.
  await page.goto(`${origins.native}/dashboard#keys`, { waitUntil: "domcontentloaded" })
  await control("hold")
  const browserReachBefore = (await control("state")).held.reached
  await page.getByRole("row").filter({ hasText: "C12 Capability Key" }).click()
  await page.getByRole("button", { name: "Codex", exact: true }).click()
  await waitForSnippet("false", origins.native)
  await waitUntil(async () => (await control("state")).held.reached === browserReachBefore + 1, "held browser capability read")
  await openConfig(origins.direct)
  await waitForSnippet("false", origins.direct)
  await control("release")
  await waitUntil(async () => (await control("state")).held.forwarded >= browserReachBefore + 1, "old-origin read release")
  await pause(150)
  await waitForSnippet("false", origins.direct)
  assert.deepEqual(pageErrors, [])

  const result = {
    status: structuredAssertions.length ? "probe-passed-contract-provided" : "partial-contract-pending",
    sourceRoot, capabilityPath, booleanPointer,
    checks: ["native/direct/failure HTTP", "auth", "no-store", "no capability egress",
      "same-process concurrent isolation", "native 101", "direct 426", "matched/unmatched Codex catalog",
      "browser native/direct/failure", "browser origin switch and late response"],
    structuredAssertions: structuredAssertions.length,
    snippets: { native: nativeSnippet, direct: directSnippet, failedNative: failedSnippet },
    fixture: await control("state"), pageErrors,
  }
  writeFileSync(join(runDir, "result.json"), JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
}
