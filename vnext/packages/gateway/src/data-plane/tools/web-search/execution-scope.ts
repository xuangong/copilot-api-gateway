import type { WebSearchCallIR, WebSearchExecutionSession, WebSearchWorkTracker } from "./operations.ts"
import { runWebSearchCallPlan, splitWebSearchCalls, startWebSearchCallFetches, type WebSearchCallPlan } from "./plan-operations.ts"
import { countWebSearchOperations, validateWebSearchCapacityPolicy, WebSearchCapacityError, type WebSearchCapacityPolicy } from "./capacity.ts"

declare const admissionBrand: unique symbol
export interface WebSearchAdmission { readonly [admissionBrand]: true }

export interface WebSearchExecutionScope {
  admit(args: Record<string, unknown> | null): WebSearchAdmission
  prepare(admission: WebSearchAdmission): PreparedWebSearchBatch
  refuse(admission: WebSearchAdmission): void
  assertOpen(): void
  cancel(): undefined
  settled(): Promise<void>
}

export interface PreparedWebSearchBatch {
  readonly plans: readonly WebSearchCallPlan[]
  start(): StartedWebSearchBatch
}

export interface StartedWebSearchBatch {
  readonly calls: readonly {
    readonly plan: WebSearchCallPlan
    result(): Promise<WebSearchCallIR>
  }[]
}

// Kept in the source typecheck: async cancellation cannot implement this port.
type AssertTrue<T extends true> = T
export type WebSearchScopeRejectsAsyncCancel = AssertTrue<
  (() => Promise<void>) extends WebSearchExecutionScope["cancel"] ? false : true
>

export const createWebSearchExecutionScope = (
  config: Omit<WebSearchExecutionSession, "pageCache">,
  capacityPolicy?: Partial<WebSearchCapacityPolicy>,
): WebSearchExecutionScope => {
  const policy = validateWebSearchCapacityPolicy(capacityPolicy)
  let operations = 0
  const admissions = new Map<WebSearchAdmission, Record<string, unknown> | null>()
  const controller = new AbortController()
  const session: WebSearchExecutionSession = { ...config, pageCache: new Map(), signal: controller.signal }
  const pending = new Set<object>()
  const settlementWaiters = new Set<() => void>()
  const deliveries = new Set<(reason: unknown) => void>()
  let closed = false

  const assertOpen = (): void => {
    controller.signal.throwIfAborted()
  }
  const work: WebSearchWorkTracker = {
    run<T>(factory: () => Promise<T>): Promise<T> {
      const registration = {}
      let resolve: (value: T | PromiseLike<T>) => void = () => undefined
      let reject: (reason: unknown) => void = () => undefined
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
      // Register and observe before invoking a factory that may cancel/reenter.
      pending.add(registration)
      const finish = (): void => {
        pending.delete(registration)
        if (pending.size === 0) {
          for (const waiter of settlementWaiters) waiter()
          settlementWaiters.clear()
        }
      }
      void promise.then(finish, finish)
      try { resolve(factory()) } catch (error) { reject(error) }
      return promise
    },
  }

  const deliver = (promise: Promise<WebSearchCallIR>): Promise<WebSearchCallIR> => {
    const result = new Promise<WebSearchCallIR>((resolve, reject) => {
      if (closed) { reject(controller.signal.reason); return }
      deliveries.add(reject)
      void promise.then(value => {
        deliveries.delete(reject)
        if (closed) reject(controller.signal.reason)
        else resolve(value)
      }, error => {
        deliveries.delete(reject)
        reject(closed ? controller.signal.reason : error)
      })
    })
    void result.then(() => undefined, () => undefined)
    return result
  }

  const onParentAbort = (): void => { cancel(config.signal?.reason) }
  const cancel = (reason: unknown = new DOMException("Web search execution closed", "AbortError")): undefined => {
    if (closed) return undefined
    closed = true
    config.signal?.removeEventListener("abort", onParentAbort)
    controller.abort(reason)
    admissions.clear()
    session.pageCache.clear()
    for (const reject of deliveries) reject(controller.signal.reason)
    deliveries.clear()
    return undefined
  }
  if (config.signal?.aborted) cancel(config.signal.reason)
  else config.signal?.addEventListener("abort", onParentAbort, { once: true })

  const consume = (admission: WebSearchAdmission): Record<string, unknown> | null => {
    assertOpen()
    if (!admissions.has(admission)) throw new Error("Invalid web search admission")
    const args = admissions.get(admission) ?? null
    admissions.delete(admission)
    return args
  }

  return {
    admit(args) {
      assertOpen()
      const charge = countWebSearchOperations(args, policy.operations - operations)
      assertOpen()
      if (charge > policy.operations - operations) throw new WebSearchCapacityError("operations", policy.operations)
      operations += charge
      const admission = {} as WebSearchAdmission
      admissions.set(admission, args)
      return admission
    },
    refuse(admission) { consume(admission) },
    assertOpen,
    cancel: () => cancel(),
    settled: () => pending.size === 0 ? Promise.resolve() : new Promise(resolve => { settlementWaiters.add(resolve) }),
    prepare(admission) {
      const args = consume(admission)
      const plans = splitWebSearchCalls(args)
      let started = false
      return {
        plans,
        start() {
          assertOpen()
          if (started) throw new Error("Web search batch already started")
          started = true
          const fetches = work.run(() => startWebSearchCallFetches(plans, session, work))
          const calls = plans.map(plan => {
            const promise = work.run(() => runWebSearchCallPlan(plan, session, fetches, work))
            return { plan, result: () => deliver(promise) }
          })
          return { calls }
        },
      }
    },
  }
}
