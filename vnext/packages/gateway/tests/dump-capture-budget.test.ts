import { expect, test } from "bun:test"
import { DumpCaptureBudget } from "../src/shared/dump/capture-budget.ts"

test("public accounting objects do not grant raw reservation or release authority", () => {
  const budget = new DumpCaptureBudget()
  const capture = budget.open().capture
  expect("reserve" in budget).toBe(false)
  expect("release" in budget).toBe(false)
  expect("release" in capture).toBe(false)
  expect("retire" in capture).toBe(false)
})

test("capture scopes share a bounded environment and release exactly once", async () => {
  const budget = new DumpCaptureBudget({ captureBytes: 1000, environmentBytes: 1500, frames: 2 })
  const scope = budget.open()
  const a = scope.capture, b = budget.open().capture
  expect(a.bytes(900)).toBe(true)
  expect(b.bytes(700)).toBe(false)
  expect(b.reason).toBe("environment_limit")
  expect(b.bytes(1)).toBe(false)
  expect(budget.retainedBytes).toBe(900)
  const retirement = scope.retire(Promise.resolve(), Promise.resolve())
  expect(scope.retire(Promise.resolve(), Promise.resolve())).toBe(retirement)
  await retirement
  expect(budget.retainedBytes).toBe(0)
  const c = budget.open().capture
  expect(c.bytes(1001)).toBe(false)
  expect(c.reason).toBe("capture_limit")
})

test("bounded graph admission never invokes getters or serializes oversized strings", () => {
  const budget = new DumpCaptureBudget({ captureBytes: 1000 })
  let invoked = false
  const accessor = budget.open().capture
  expect(accessor.graph({ get data() { invoked = true; return "secret" } })).toBe(false)
  expect(accessor.reason).toBe("unsupported_payload")
  expect(invoked).toBe(false)
  const big = budget.open().capture
  expect(big.graph({ text: "x".repeat(1_000_000) })).toBe(false)
  expect(big.reason).toBe("capture_limit")
  expect(budget.retainedBytes).toBe(0)
  const sparse = budget.open().capture
  expect(sparse.graph(new Array(1_000_000))).toBe(false)
  expect(sparse.reason).toBe("capture_limit")
})

test("frame count and cyclic/deep graphs fail with an explicit capture outcome", async () => {
  const budget = new DumpCaptureBudget({ frames: 1 })
  const scope = budget.open()
  const capture = scope.capture
  expect(capture.frame({ type: "event", event: { text: "ok" } })).toEqual({ value: { type: "event", event: { text: "ok" } } })
  expect(capture.frame({ type: "event", event: { text: "extra" } })).toBeUndefined()
  expect(capture.reason).toBe("frame_limit")
  await scope.retire(Promise.resolve(), Promise.resolve())
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  const cyclic = budget.open().capture
  expect(cyclic.graph(cycle)).toBe(false)
  expect(cyclic.reason).toBe("unsupported_payload")
  expect(budget.retainedBytes).toBe(0)
})

test("private projections omit hidden state, preserve JSON order and reject custom serialization", async () => {
  const budget = new DumpCaptureBudget()
  const source = { text: "original", nested: { value: 1 } }
  Object.defineProperty(source, "private", { value: { retained: "x".repeat(1_000_000) } })
  Object.defineProperty(source, Symbol("private"), { value: () => source })
  const scope = budget.open()
  const capture = scope.capture
  const captured = capture.project(source)
  expect(captured).toBeDefined()
  expect(JSON.stringify(captured?.value)).toBe(JSON.stringify(source))
  expect(Reflect.ownKeys(captured?.value ?? {})).toEqual(["text", "nested"])
  source.nested.value = 2
  expect(captured?.value.nested.value).toBe(1)
  await scope.retire(Promise.resolve(), Promise.resolve())
  let invoked = false
  const custom = Object.defineProperty({}, "toJSON", { value: () => { invoked = true; return "different" } })
  const rejected = budget.open().capture
  expect(rejected.graph(custom)).toBe(false)
  expect(rejected.reason).toBe("unsupported_payload")
  expect(invoked).toBe(false)
})

test("array projection keeps non-enumerable indices and ordinary toJSON data fields exact", async () => {
  const budget = new DumpCaptureBudget({ captureBytes: 1000 })
  const array = ["keep"]
  Object.defineProperty(array, "0", { enumerable: false })
  Object.defineProperty(array, "extra", { enumerable: true, value: "x".repeat(1_000_000) })
  const scope = budget.open()
  const capture = scope.capture
  const projected = capture.project({ array, toJSON: "user-data" })
  expect(projected).toBeDefined()
  expect(JSON.stringify(projected?.value)).toBe(JSON.stringify({ array, toJSON: "user-data" }))
  expect(Reflect.ownKeys(projected?.value.array ?? [])).toEqual(["0", "length"])
  await scope.retire(Promise.resolve(), Promise.resolve())
  expect(budget.retainedBytes).toBe(0)
})

for (const first of ["work", "preparation"] as const) {
  for (const failure of ["none", "work", "preparation", "both"] as const) {
    test(`${first} settles first with ${failure} rejection; retirement waits for both and preserves precedence`, async () => {
      const budget = new DumpCaptureBudget({ captureBytes: 1000, environmentBytes: 1500 })
      const scope = budget.open(), capture = scope.capture
      const work = Promise.withResolvers<void>(), preparation = Promise.withResolvers<void>()
      const workError = new Error("work failed"), preparationError = new Error("preparation failed")
      expect(capture.bytes(900)).toBe(true)
      const retiring = scope.retire(work.promise, preparation.promise)
      let settled = false
      const outcome = retiring.then(() => { settled = true; return undefined }, error => { settled = true; return error as unknown })
      const settle = (phase: "work" | "preparation"): void => {
        const receipt = phase === "work" ? work : preparation
        if (failure === phase || failure === "both") receipt.reject(phase === "work" ? workError : preparationError)
        else receipt.resolve()
      }
      settle(first)
      await (first === "work" ? work.promise : preparation.promise).catch(() => {})
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(budget.retainedBytes).toBe(900)
      // The response drain may still admit payload after retirement is selected.
      expect(capture.bytes(20)).toBe(true)
      expect(capture.graph(null)).toBe(true)
      expect(capture.frame(null)).toEqual({ value: null })
      expect(budget.retainedBytes).toBe(952)
      settle(first === "work" ? "preparation" : "work")
      expect(await outcome).toBe(failure === "preparation" || failure === "both" ? preparationError : failure === "work" ? workError : undefined)
      expect(budget.retainedBytes).toBe(0)
      expect(scope.retire(Promise.resolve(), Promise.resolve())).toBe(retiring)
      expect(capture.bytes(1)).toBe(false)
      expect(capture.graph(null)).toBe(false)
      expect(capture.project(null)).toBeUndefined()
      expect(capture.frame(null)).toBeUndefined()
      expect(capture.reason).toBeUndefined()
      expect(budget.retainedBytes).toBe(0)
    })
  }
}

test("first retirement binds ownership while replacement work cannot release or hold the scope", async () => {
  const budget = new DumpCaptureBudget({ captureBytes: 1000, environmentBytes: 1000 })
  const scope = budget.open()
  expect(scope.capture.bytes(900)).toBe(true)
  const work = Promise.withResolvers<void>(), preparation = Promise.withResolvers<void>()
  const replacementWork = Promise.withResolvers<void>(), replacementPreparation = Promise.withResolvers<void>()
  const retirement = scope.retire(work.promise, preparation.promise)
  expect(scope.retire(Promise.resolve(), Promise.resolve())).toBe(retirement)
  expect(scope.retire(replacementWork.promise, replacementPreparation.promise)).toBe(retirement)
  await Promise.resolve()
  expect(budget.retainedBytes).toBe(900)
  const blocked = budget.open().capture
  expect(blocked.bytes(200)).toBe(false)
  expect(blocked.reason).toBe("environment_limit")
  work.resolve()
  preparation.resolve()
  await retirement
  expect(budget.retainedBytes).toBe(0)
  const recovered = budget.open()
  expect(recovered.capture.bytes(1000)).toBe(true)
  expect(blocked.bytes(1)).toBe(false)
  expect(blocked.reason).toBe("environment_limit")
  expect(scope.capture.bytes(1)).toBe(false)
  expect(budget.retainedBytes).toBe(1000)
  await recovered.retire(Promise.resolve(), Promise.resolve())
  expect(budget.availableBytes).toBe(1000)
})

test("retirement is memoized before observing bound promises can reenter", async () => {
  const budget = new DumpCaptureBudget()
  const scope = budget.open()
  expect(scope.capture.bytes(900)).toBe(true)
  const work = Promise.resolve(), preparation = Promise.withResolvers<void>()
  const originalThen = work.then.bind(work)
  let reentered: Promise<void> | undefined
  Object.defineProperty(work, "then", { value: (...args: Parameters<typeof work.then>) => {
    reentered = scope.retire(Promise.resolve(), Promise.resolve())
    return originalThen(...args)
  } })
  const retirement = scope.retire(work, preparation.promise)
  expect(reentered).toBe(retirement)
  await work
  expect(budget.retainedBytes).toBe(900)
  preparation.resolve()
  await retirement
  expect(budget.retainedBytes).toBe(0)
})

for (const brokenPhase of ["work", "preparation"] as const) {
  for (const observation of ["getter", "method"] as const) {
    for (const otherRejects of [false, true]) {
      test(`${brokenPhase} then ${observation} throws; retirement observes and waits for the other ${otherRejects ? "rejected" : "fulfilled"} phase`, async () => {
        const budget = new DumpCaptureBudget()
        const scope = budget.open()
        const broken = Promise.withResolvers<void>(), other = Promise.withResolvers<void>()
        const observationError = new Error("phase observation failed"), otherError = new Error("other phase failed")
        expect(scope.capture.bytes(900)).toBe(true)
        if (observation === "getter") Object.defineProperty(broken.promise, "then", { get() { throw observationError } })
        else Object.defineProperty(broken.promise, "then", { value() { throw observationError } })
        let otherObserved = false
        const originalThen = other.promise.then.bind(other.promise)
        Object.defineProperty(other.promise, "then", { value: (...args: Parameters<typeof other.promise.then>) => {
          otherObserved = true
          return originalThen(...args)
        } })
        const retirement = scope.retire(brokenPhase === "work" ? broken.promise : other.promise,
          brokenPhase === "preparation" ? broken.promise : other.promise)
        let settled = false, outcome: unknown
        void retirement.then(() => { settled = true }, error => { settled = true; outcome = error })
        try {
          expect(otherObserved).toBe(true)
          expect(scope.retire(Promise.resolve(), Promise.resolve())).toBe(retirement)
          await Promise.resolve()
          expect(settled).toBe(false)
          expect(budget.retainedBytes).toBe(900)
          expect(scope.capture.bytes(20)).toBe(true)
          if (otherRejects) other.reject(otherError)
          else other.resolve()
          // Yield one event-loop turn so every already-queued retirement reaction runs.
          await Bun.sleep(0)
          expect(settled).toBe(true)
          expect(outcome).toBe(brokenPhase === "work" && otherRejects ? otherError : observationError)
          expect(budget.retainedBytes).toBe(0)
          expect(scope.capture.bytes(1)).toBe(false)
          expect(scope.retire(Promise.resolve(), Promise.resolve())).toBe(retirement)
        } finally { broken.resolve(); other.resolve() }
      })
    }
  }
}
