/**
 * The Bun image installs dependencies from workspace manifests alone (for
 * layer caching), so every workspace package.json must be copied before
 * `bun install --frozen-lockfile`. A new package missing here passes local
 * tests and the Cloudflare deploy, then fails only the Docker build — which
 * happened when packages/test-utils was added.
 */
import { expect, test } from "bun:test"
import { Glob } from "bun"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../..")

test("the Bun Dockerfile copies every workspace manifest before installing", async () => {
  const dockerfile = await Bun.file(join(ROOT, "apps/platform-bun/Dockerfile")).text()
  const installAt = dockerfile.search(/^RUN .*bun install/m)
  expect(installAt).toBeGreaterThan(0)
  const beforeInstall = dockerfile.slice(0, installAt)
  const missing: string[] = []
  for await (const manifest of new Glob("{apps,packages}/*/package.json").scan(ROOT)) {
    if (!beforeInstall.includes(`COPY ${manifest} `)) missing.push(manifest)
  }
  expect(missing).toEqual([])
})
