import type { BindingModel, LlmProviderBinding } from "@vibe-llm/provider-llm"
import type { CatalogSnapshot } from "../../repo/catalogs.ts"
import { sameCatalogIdentity } from "./catalog-coordinator.ts"

/** Execution capabilities and permission decisions never enter the shared projection. */
export type RoutingBindingDescriptor = Readonly<Omit<LlmProviderBinding, "provider" | "model">> & {
  readonly model: Readonly<BindingModel>
}
export type RoutingScope =
  | { readonly kind: "global" }
  | { readonly kind: "owner"; readonly ownerId: string }
  | { readonly kind: "all-owners" }

export interface ProjectedModel {
  readonly publicId: string
  readonly model: BindingModel
}

/** Catalogs are JSON data. Freeze the accepted data in place, including nested
 * raw metadata, and estimate retained size without serializing another copy. */
function freezeAndEstimate(root: unknown): number {
  const visited = new WeakSet<object>()
  const pending: unknown[] = [root]
  let bytes = 0
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === "string") bytes += value.length * 2 + 16
    else if (value !== null && typeof value === "object") {
      if (visited.has(value)) continue
      visited.add(value)
      bytes += 32
      for (const [key, child] of Object.entries(value)) {
        bytes += key.length * 2 + 16
        pending.push(child)
      }
      Object.freeze(value)
    } else bytes += 8
  }
  return bytes
}

export class RoutingProjection {
  readonly entries: readonly ProjectedModel[]
  readonly estimatedBytes: number
  readonly #byId = new Map<string, Array<{ entry: ProjectedModel; order: number }>>()
  constructor(entries: ProjectedModel[], acceptedCatalog?: unknown) {
    this.estimatedBytes = freezeAndEstimate([entries, acceptedCatalog]) + entries.length * 96
    this.entries = entries
    for (const [order, entry] of entries.entries()) {
      const rows = this.#byId.get(entry.model.id) ?? []
      rows.push({ entry, order })
      this.#byId.set(entry.model.id, rows)
    }
    Object.freeze(this)
  }
  find(ids: readonly string[]): readonly ProjectedModel[] {
    return [...new Set(ids)].flatMap(id => this.#byId.get(id) ?? [])
      .sort((a, b) => a.order - b.order).map(value => value.entry)
  }
}

interface ProjectionEntry {
  readonly identity: CatalogSnapshot["identity"]
  readonly publicationVersion: number
  readonly projection: RoutingProjection
}

/** One latest publication per upstream, with both cardinality and size bounds.
 * Oversized catalogs remain supported but are only retained by their request. */
export class RoutingProjectionCache {
  readonly #entries = new Map<string, ProjectionEntry>()
  #models = 0
  #bytes = 0
  constructor(private readonly limits = { upstreams: 512, models: 16_384, bytes: 16 * 1024 * 1024 }) {}
  get(snapshot: CatalogSnapshot): RoutingProjection | undefined {
    const entry = this.#entries.get(snapshot.identity.upstreamId)
    if (!entry || entry.publicationVersion !== snapshot.publicationVersion
      || !sameCatalogIdentity(entry.identity, snapshot.identity)) return undefined
    // A coordinator refresh can reload the same publication into new objects.
    // Ordinary retained hits are already frozen and do no catalog traversal.
    if (!Object.isFrozen(snapshot.models)) freezeAndEstimate(snapshot.models)
    this.#entries.delete(snapshot.identity.upstreamId)
    this.#entries.set(snapshot.identity.upstreamId, entry)
    return entry.projection
  }
  set(snapshot: CatalogSnapshot, projection: RoutingProjection): void {
    this.remove(snapshot.identity.upstreamId)
    if (projection.entries.length > this.limits.models || projection.estimatedBytes > this.limits.bytes) return
    this.#entries.set(snapshot.identity.upstreamId, {
      identity: Object.freeze({ ...snapshot.identity }), publicationVersion: snapshot.publicationVersion, projection,
    })
    this.#models += projection.entries.length
    this.#bytes += projection.estimatedBytes
    while (this.#entries.size > this.limits.upstreams || this.#models > this.limits.models || this.#bytes > this.limits.bytes) {
      const first = this.#entries.keys().next()
      if (first.done) break
      this.remove(first.value)
    }
  }
  private remove(id: string): void {
    const previous = this.#entries.get(id)
    if (!previous) return
    this.#models -= previous.projection.entries.length
    this.#bytes -= previous.projection.estimatedBytes
    this.#entries.delete(id)
  }
}
