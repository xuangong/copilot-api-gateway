import type { DumpCaptureOmission } from "./types.ts"

interface Limits { captureBytes: number; environmentBytes: number; frames: number }
export const DUMP_CAPTURE_LIMITS: Readonly<Limits> = Object.freeze({
  captureBytes: 4 * 1024 * 1024,
  environmentBytes: 16 * 1024 * 1024,
  frames: 8192,
})

type Estimate = { bytes: number; value: unknown } | { reason: "capture_limit" | "unsupported_payload" | "invalid_json" }

// Charge strings/keys for retained UTF-16 and copy only enumerable JSON data.
// This is accounting, not a V8 heap or codec working-memory measurement. Do
// not stringify, invoke getters or materialize a complete keys array here.
function projectGraph(root: unknown, limit: number): Estimate {
  let bytes = 0, nodes = 0
  const active = new WeakSet<object>()
  const visit = (value: unknown, depth: number): Estimate => {
    if (++nodes > 65_536 || depth > 64) return { reason: "capture_limit" }
    if (typeof value === "string") bytes += value.length * 2 + 32
    else if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) bytes += 16
    else if (typeof value !== "object") return { reason: typeof value === "bigint" ? "invalid_json" : "unsupported_payload" }
    else {
      if (active.has(value)) return { reason: "invalid_json" }
      const prototype: unknown = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return { reason: "unsupported_payload" }
      // Callable/accessor toJSON changes serialization even when non-enumerable.
      // An ordinary JSON data field named toJSON remains ordinary data.
      const serializer = Object.getOwnPropertyDescriptor(value, "toJSON")
        ?? (prototype ? Object.getOwnPropertyDescriptor(prototype, "toJSON") : undefined)
        ?? (prototype === Array.prototype ? Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") : undefined)
      if (serializer && (!("value" in serializer) || typeof serializer.value === "function")) return { reason: "unsupported_payload" }
      bytes += 64
      if (Array.isArray(value)) bytes += value.length * 16
      if (bytes > limit) return { reason: "capture_limit" }
      const copy: object = Array.isArray(value) ? new Array<unknown>(value.length) : {}
      active.add(value)
      if (Array.isArray(value)) {
        // JSON arrays read every index, including non-enumerable indices, but
        // ignore named extra properties. Length was bounded before allocation.
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, index)
          if (!descriptor) {
            if (index in value) return { reason: "unsupported_payload" }
            continue
          }
          if (!("value" in descriptor)) return { reason: "unsupported_payload" }
          const child = visit(descriptor.value, depth + 1)
          if ("reason" in child) return child
          Object.defineProperty(copy, index, { value: child.value, writable: true, enumerable: true, configurable: true })
        }
      } else {
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue
          bytes += key.length * 2 + 32
          if (bytes > limit) return { reason: "capture_limit" }
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          if (!descriptor || !("value" in descriptor)) return { reason: "unsupported_payload" }
          const child = visit(descriptor.value, depth + 1)
          if ("reason" in child) return child
          Object.defineProperty(copy, key, { value: child.value, writable: true, enumerable: true, configurable: true })
        }
      }
      active.delete(value)
      return { bytes, value: copy }
    }
    return bytes > limit ? { reason: "capture_limit" } : { bytes, value }
  }
  try { return visit(root, 0) } catch { return { reason: "unsupported_payload" } }
}

/** Per-environment payload reservations only. Metadata/publication slots and
 * runtime/codec working memory are separate resource domains. No wait queue. */
export class DumpCaptureBudget {
  readonly limits: Readonly<Limits>
  private retained = 0
  constructor(limits: Partial<Limits> = {}) {
    this.limits = Object.freeze({ ...DUMP_CAPTURE_LIMITS, ...limits })
    for (const key of ["captureBytes", "environmentBytes", "frames"] as const) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 0 || this.limits[key] > DUMP_CAPTURE_LIMITS[key]) {
        throw new TypeError("Invalid dump capture policy")
      }
    }
  }
  get retainedBytes(): number { return this.retained }
  get availableBytes(): number { return this.limits.environmentBytes - this.retained }
  open(): DumpCaptureReservation { return new DumpCaptureReservation(this) }
  reserve(bytes: number): boolean {
    if (bytes > this.availableBytes) return false
    this.retained += bytes
    return true
  }
  release(bytes: number): void { this.retained -= bytes }
}

export class DumpCaptureReservation {
  private retained = 0
  private frames = 0
  private released = false
  private omitted: DumpCaptureOmission | undefined
  private invalidSerialization = false
  constructor(private readonly owner: DumpCaptureBudget) {}
  get reason(): DumpCaptureOmission | undefined { return this.omitted }
  get invalidJson(): boolean { return this.invalidSerialization }

  bytes(bytes: number): boolean {
    if (this.released || this.omitted) return false
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.owner.limits.captureBytes - this.retained) {
      this.omitted = "capture_limit"
      return false
    }
    if (!this.owner.reserve(bytes)) { this.omitted = "environment_limit"; return false }
    this.retained += bytes
    return true
  }
  graph(value: unknown): boolean { return this.project(value) !== undefined }
  project<T>(value: T): { value: T } | undefined {
    if (this.released || this.omitted) return undefined
    const available = Math.min(this.owner.limits.captureBytes - this.retained, this.owner.availableBytes)
    const estimate = projectGraph(value, available)
    if ("reason" in estimate) {
      this.invalidSerialization = estimate.reason === "invalid_json"
      this.omitted = estimate.reason === "unsupported_payload" || this.invalidSerialization ? "unsupported_payload"
        : this.owner.availableBytes < this.owner.limits.captureBytes - this.retained ? "environment_limit" : "capture_limit"
      return undefined
    }
    return this.bytes(estimate.bytes) ? { value: estimate.value as T } : undefined
  }
  frame<T>(value: T): { value: T } | undefined {
    if (this.released || this.omitted) return undefined
    if (this.frames >= this.owner.limits.frames) { this.omitted = "frame_limit"; return undefined }
    const captured = this.project(value)
    if (!captured) return undefined
    this.frames++
    return captured
  }
  release(): void {
    if (this.released) return
    this.released = true
    this.owner.release(this.retained)
    this.retained = 0
  }
}

// The completion retains only a small reservation and a body-free preparation
// receipt. Rejection does not release accounting while preparation still runs.
export function retireDumpCapture(work: Promise<void>, preparation: Promise<void>, capture: DumpCaptureReservation): Promise<void> {
  return work.finally(async () => { await preparation; capture.release() })
}
