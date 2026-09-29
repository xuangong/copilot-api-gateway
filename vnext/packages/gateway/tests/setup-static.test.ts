import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { setupStaticRouter } from "../src/control-plane/setup/static"
test("public setup assets are fixed, credential-free and checksum-consistent", async () => {
  const runner = await setupStaticRouter.request("/setup/runner.mjs")
  expect(runner.status).toBe(200)
  expect(runner.headers.get("content-type")).toContain("text/javascript")
  expect(runner.headers.get("cache-control")).toBe("no-store")
  const text = await runner.text()
  const digest = createHash("sha256").update(text).digest("hex")
  expect((await (await setupStaticRouter.request("/setup/runner.sha256")).text()).trim()).toBe(digest)
  for (const file of ["setup.sh", "setup.ps1"]) {
    const response = await setupStaticRouter.request("/setup/" + file)
    expect(response.status).toBe(200)
    const content = await response.text()
    expect(content).toContain(digest)
    expect(content).not.toContain("__RUNNER_SHA256__")
    expect(content).not.toMatch(/stl_[0-9a-f]{64}/)
  }
  expect((await setupStaticRouter.request("/setup/missing")).status).toBe(404)
  expect((await setupStaticRouter.request("/setup/runner.mjs?token=not-accepted")).status).toBe(404)
})

for (const name of ["toString", "constructor", "__proto__"]) test(`public setup assets reject inherited property ${name}`, async () => {
  expect((await setupStaticRouter.request("/setup/" + name)).status).toBe(404)
})
