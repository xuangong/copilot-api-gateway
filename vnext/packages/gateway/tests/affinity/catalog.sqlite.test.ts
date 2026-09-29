import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BunSqliteRepo } from "../../../../apps/platform-bun/src/bun-sqlite-repo.ts"
import { modelToBindingModel, MODEL_CATALOG_REVISION } from "../../src/data-plane/providers/registry.ts"
import type { Model } from "@vibe-llm/provider-copilot"
import type { LlmModelProvider } from "@vibe-llm/provider-llm"

const model = { id: "raw-model", object: "model", name: "model", vendor: "vendor", version: "1", preview: false, model_picker_enabled: true,
  capabilities: { family: "display-family", limits: {}, object: "model_capabilities", supports: {}, tokenizer: "unknown", type: "chat" },
  opaqueCompatibility: { version: 1, key: "untrusted-openai", scope: "owner" },
  providerData: { opaqueCompatibility: { version: 1, key: "untrusted-nested", scope: "owner" } },
} satisfies Model & Record<string, unknown>
const declared = { version: 1 as const, key: "trusted-contract-v1", scope: "credential" as const }
const provider: Pick<LlmModelProvider, "supportedEndpoints" | "getOpaqueCompatibilityForModel"> = {
  supportedEndpoints: ["responses"],
  getOpaqueCompatibilityForModel(candidate) { expect(candidate.id).toBe("raw-model"); expect(candidate.opaqueCompatibility).toBeUndefined(); return declared },
}

test("registry binding ignores malicious raw declarations, validates the trusted hook and snapshots its result", () => {
  expect(modelToBindingModel(model, "custom", { supportedEndpoints: ["responses"] }).opaqueCompatibility).toBeUndefined()
  const projected = modelToBindingModel(model, "custom", provider)
  expect(projected.opaqueCompatibility).toEqual(declared)
  expect(projected.opaqueCompatibility).not.toBe(declared)
  expect(() => modelToBindingModel(model, "custom", { ...provider, getOpaqueCompatibilityForModel: () => ({ version: 1, key: "", scope: "owner" }) })).toThrow()
})

test("real catalog persistence rebuilds the same trusted declaration and never promotes raw declarations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "affinity-catalog-"))
  const path = join(dir, "catalog.sqlite")
  const a = new Database(path)
  const first = new BunSqliteRepo(a)
  const b = new Database(path)
  const second = new BunSqliteRepo(b)
  try {
    await first.upstreams.save({ id: "up", provider: "custom", name: "up", enabled: true, sortOrder: 0, config: {}, state: {},
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "now", updatedAt: "now" })
    const row = await first.upstreams.list()
    const upstream = row[0]
    if (!upstream) throw new Error("missing upstream")
    const observation = await first.catalogs.read(upstream.id, MODEL_CATALOG_REVISION)
    if (!observation) throw new Error("missing observation")
    const lease = await first.catalogs.tryAcquire(observation.identity)
    if (!lease) throw new Error("missing lease")
    await first.catalogs.publish(lease, { object: "list", data: [model] })
    const snapshot = (await second.catalogs.read(upstream.id, MODEL_CATALOG_REVISION))?.snapshot
    const stored = snapshot?.models.data[0]
    if (!stored) throw new Error("missing catalog model")
    // SQL catalog boundary mirrors the registry's existing ModelsResponse projection.
    const reconstructed = stored as unknown as Model
    expect(modelToBindingModel(reconstructed, "custom", provider)).toEqual(modelToBindingModel(model, "custom", provider))
    expect(modelToBindingModel(reconstructed, "custom", { supportedEndpoints: ["responses"] }).opaqueCompatibility).toBeUndefined()
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) }
})
