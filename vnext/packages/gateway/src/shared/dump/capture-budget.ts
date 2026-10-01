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

export interface DumpCapture {
  readonly reason: DumpCaptureOmission | undefined
  readonly invalidJson: boolean
  bytes(bytes: number): boolean
  graph(value: unknown): boolean
  project<T>(value: T): { value: T } | undefined
  frame<T>(value: T): { value: T } | undefined
}

export interface DumpCaptureScope {
  readonly capture: DumpCapture
  retire(work: Promise<void>, preparation: Promise<void>): Promise<void>
}

interface BudgetState { readonly limits: Readonly<Limits>; retained: number }
interface CaptureState {
  readonly budget: BudgetState
  retained: number
  frames: number
  retired: boolean
  omitted: DumpCaptureOmission | undefined
  invalidSerialization: boolean
}

/** Per-environment payload reservations only. Metadata/publication slots and
 * runtime/codec working memory are separate resource domains. No wait queue. */
export class DumpCaptureBudget {
  #state: BudgetState
  constructor(limits: Partial<Limits> = {}) {
    const policy = Object.freeze({ ...DUMP_CAPTURE_LIMITS, ...limits })
    for (const key of ["captureBytes", "environmentBytes", "frames"] as const) {
      if (!Number.isSafeInteger(policy[key]) || policy[key] < 0 || policy[key] > DUMP_CAPTURE_LIMITS[key]) {
        throw new TypeError("Invalid dump capture policy")
      }
    }
    this.#state = { limits: policy, retained: 0 }
  }
  get limits(): Readonly<Limits> { return this.#state.limits }
  get retainedBytes(): number { return this.#state.retained }
  get availableBytes(): number { return this.#state.limits.environmentBytes - this.#state.retained }
  open(): DumpCaptureScope { return new CaptureScope(this.#state) }
}

class CaptureFacade implements DumpCapture {
  #state: CaptureState
  constructor(state: CaptureState) { this.#state = state }
  get reason(): DumpCaptureOmission | undefined { return this.#state.omitted }
  get invalidJson(): boolean { return this.#state.invalidSerialization }

  bytes(bytes: number): boolean {
    const state = this.#state, budget = state.budget
    if (state.retired || state.omitted) return false
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.limits.captureBytes - state.retained) {
      state.omitted = "capture_limit"
      return false
    }
    if (bytes > budget.limits.environmentBytes - budget.retained) { state.omitted = "environment_limit"; return false }
    budget.retained += bytes
    state.retained += bytes
    return true
  }
  graph(value: unknown): boolean { return this.project(value) !== undefined }
  project<T>(value: T): { value: T } | undefined {
    const state = this.#state, budget = state.budget
    if (state.retired || state.omitted) return undefined
    const available = Math.min(budget.limits.captureBytes - state.retained, budget.limits.environmentBytes - budget.retained)
    const estimate = projectGraph(value, available)
    if ("reason" in estimate) {
      state.invalidSerialization = estimate.reason === "invalid_json"
      state.omitted = estimate.reason === "unsupported_payload" || state.invalidSerialization ? "unsupported_payload"
        : budget.limits.environmentBytes - budget.retained < budget.limits.captureBytes - state.retained ? "environment_limit" : "capture_limit"
      return undefined
    }
    return this.bytes(estimate.bytes) ? { value: estimate.value as T } : undefined
  }
  frame<T>(value: T): { value: T } | undefined {
    const state = this.#state
    if (state.retired || state.omitted) return undefined
    if (state.frames >= state.budget.limits.frames) { state.omitted = "frame_limit"; return undefined }
    const captured = this.project(value)
    if (!captured) return undefined
    state.frames++
    return captured
  }
}

// This reaction retains only scalar accounting state and the void completion
// receipt, never the caller's work/preparation promises or payload graphs.
function finishRetirement(state: CaptureState, completion: PromiseWithResolvers<void>) {
  return ([work, preparation]: [PromiseSettledResult<void>, PromiseSettledResult<void>]): void => {
    state.retired = true
    state.budget.retained -= state.retained
    state.retained = 0
    if (preparation.status === "rejected") completion.reject(preparation.reason)
    else if (work.status === "rejected") completion.reject(work.reason)
    else completion.resolve()
  }
}

class CaptureScope implements DumpCaptureScope {
  #state: CaptureState
  #capture: DumpCapture
  #retirement: Promise<void> | undefined
  constructor(budget: BudgetState) {
    this.#state = { budget, retained: 0, frames: 0, retired: false, omitted: undefined, invalidSerialization: false }
    this.#capture = new CaptureFacade(this.#state)
  }
  get capture(): DumpCapture { return this.#capture }
  retire(work: Promise<void>, preparation: Promise<void>): Promise<void> {
    if (this.#retirement) return this.#retirement
    const completion = Promise.withResolvers<void>()
    // Bind the receipt before observing promises whose then() may reenter.
    this.#retirement = completion.promise
    void Promise.allSettled([work, preparation]).then(finishRetirement(this.#state, completion))
    return this.#retirement
  }
}
