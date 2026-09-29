import type { CatalogRepo } from "./repo/catalogs.ts"
import { MODEL_CATALOG_REVISION } from "./data-plane/providers/registry.ts"

/** The deployment supplies its complete rolling revision inventory; missing policy is inert. */
export async function sweepCatalogs(catalogs: CatalogRepo, now: number, policy: string): Promise<void> {
  let revisions: unknown
  try { revisions = JSON.parse(policy) } catch { return }
  if (!Array.isArray(revisions) || revisions.length === 0 || revisions.length > 32
    || !revisions.every((value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    || new Set(revisions).size !== revisions.length || !revisions.includes(MODEL_CATALOG_REVISION)) return
  await catalogs.deleteInactiveRevisions({ activeRevisions: revisions as number[],
    inactiveBeforeMs: Math.max(0, now - 7 * 24 * 60 * 60 * 1000), limit: 128,
    maximumRevision: MODEL_CATALOG_REVISION })
}
