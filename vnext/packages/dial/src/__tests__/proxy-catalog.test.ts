import { expect, test } from "bun:test"
import { loadProxyCatalog, parseProxyCatalog } from "../proxy-catalog.ts"
import type { ProxyRecord } from "@vibe-core/proxy-repo"

const row = (id: string, url: string, timeout: number | null = null): ProxyRecord => ({
  id, name: id, url, dialTimeoutSeconds: timeout,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
})

test("captured-row compilation isolates referenced malformed rows and preserves proxy deadlines", () => {
  const catalog = parseProxyCatalog([
    row("valid", "http://proxy.invalid:8080", 3),
    row("bad", "trojan://fake-password@proxy.invalid:99999"),
    { ...row("unused", "ignored"), get url(): string { throw new Error("unreferenced URL consumed") } },
  ], id => id !== "unused")
  expect(catalog.proxyById.get("valid")).toMatchObject({ config: { kind: "http", host: "proxy.invalid", port: 8080 }, dialTimeoutMs: 3000 })
  expect(catalog.proxyById.has("bad")).toBe(false)
  expect([...catalog.parseErrors.keys()]).toEqual(["bad"])
})

test("loading skips an empty reference set and propagates repository failures", async () => {
  const proxies = { list: async (): Promise<ProxyRecord[]> => { throw new Error("catalog read failure") } }
  const empty = await loadProxyCatalog(proxies, new Set())
  expect(empty.proxyById.size).toBe(0)
  expect(empty.parseErrors.size).toBe(0)
  await expect(loadProxyCatalog(proxies, new Set(["valid"]))).rejects.toThrow("catalog read failure")
})
