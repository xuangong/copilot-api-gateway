import { chromium } from "/Users/zhangxian/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
const connection = process.env.C08_CONNECTION
assert(connection)
const { port, token, sourceRoot } = JSON.parse(readFileSync(connection, "utf8"))
const base = `http://127.0.0.1:${port}`, out = dirname(connection)
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addCookies([{ name: "session_token", value: token, domain: "127.0.0.1", path: "/" }])
  const page = await context.newPage(), pageErrors = [], writes = []
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("request", request => {
    if (request.url().startsWith(`${base}/api/upstreams`) && ["POST", "PATCH"].includes(request.method())) writes.push({ method: request.method(), body: request.postDataJSON() })
  })
  const list = await context.request.get(`${base}/api/upstreams?includeDisabled=1`)
  assert.equal(list.status(), 200)
  const text = await list.text()
  assert(!text.includes("SYNTHETIC_C08_PRIVATE"))
  for (const row of JSON.parse(text).upstreams) { assert(!("state" in row)); assert(!("rowIncarnation" in row)) }
  await page.goto(`${base}/dashboard#upstreams`)
  await page.waitForLoadState("networkidle")
  for (const provider of ["codex", "claude-code"]) {
    const name = `C08 ${provider}`
    await page.getByText(name, { exact: true }).waitFor()
    const card = page.locator("div.bg-surface-900").filter({ has: page.getByText(name, { exact: true }) }).first()
    assert.equal(await card.getByRole("button", { name: /Duplicate/ }).count(), 0)
    await card.getByRole("button", { name: "Edit", exact: true }).click()
    const form = page.locator("div.rounded-lg.mt-2").filter({ has: page.getByText(new RegExp(`^Edit\\s+${provider}\\s+Upstream$`, "i")) })
    await form.getByRole("button", { name: "Save", exact: true }).waitFor()
    assert.equal(await form.locator('input[type="password"]').count(), 0)
    await form.locator("input").first().fill(`${name} edited`)
    await page.screenshot({ path: `${out}/${provider}-edit.png`, fullPage: true })
    const response = page.waitForResponse(response => response.url().endsWith(`/api/upstreams/up_c08_${provider}`) && response.request().method() === "PATCH")
    await form.getByRole("button", { name: "Save", exact: true }).click()
    assert.equal((await response).status(), 200)
    await page.getByText(`${name} edited`, { exact: true }).waitFor()
  }
  assert.equal(writes.length, 2)
  for (const write of writes) { assert.equal(write.method, "PATCH"); assert(!("config" in write.body)); assert(!("state" in write.body)) }
  const verification = await (await context.request.get(`${base}/__verify`)).json()
  for (const row of verification) { assert(row.statePreserved); assert(row.configPreserved); assert.equal(row.name, `C08 ${row.provider} edited`) }
  await page.reload(); await page.waitForLoadState("networkidle")
  for (const row of verification) await page.getByText(row.name, { exact: true }).waitFor()
  assert.deepEqual(pageErrors, [])
  await page.screenshot({ path: `${out}/saved.png`, fullPage: true })
  const result = { passed: true, sourceRoot, providers: verification, writes, pageErrors }
  writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally { await browser.close() }
