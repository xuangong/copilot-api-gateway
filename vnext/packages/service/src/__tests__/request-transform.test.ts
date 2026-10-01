import { expect, test } from "bun:test"
import {
  beforeRequest,
  runInterceptors,
  type Interceptor,
  type RequestTransform,
} from "../index"

interface Ctx {
  tag: string
}

interface Req {
  payload: { value: number }
}

type Assert<T extends true> = T
type _AsyncTransformRejected = Assert<
  (() => Promise<undefined>) extends RequestTransform<Req> ? false : true
>
type _VoidTransformRejected = Assert<
  (() => void) extends RequestTransform<Req> ? false : true
>
type _SynchronousTransformAccepted = Assert<
  ((req: Req) => undefined) extends RequestTransform<Req> ? true : false
>

const ctx: Ctx = { tag: "request" }

test("beforeRequest normalizes the original request before delegating once", async () => {
  const req: Req = { payload: { value: 1 } }
  const originalPayload = req.payload
  const terminalPromise = Promise.resolve({ ok: true })
  let nextCalls = 0
  const interceptor = beforeRequest<Ctx, Req, { ok: boolean }>((current) => {
    expect(current).toBe(req)
    current.payload = { value: current.payload.value + 1 }
  })

  const output = interceptor(req, ctx, () => {
    nextCalls++
    expect(req.payload).not.toBe(originalPayload)
    expect(req.payload.value).toBe(2)
    return terminalPromise
  })

  expect(nextCalls).toBe(1)
  expect(output).toBe(terminalPromise)
  expect(await output).toBe(await terminalPromise)
})

test("beforeRequest passes only the request to the transform", async () => {
  const req: Req = { payload: { value: 1 } }
  let transformCalls = 0
  const interceptor = beforeRequest<Ctx, Req, string>((...args) => {
    transformCalls++
    expect(args).toHaveLength(1)
    expect(args[0]).toBe(req)
  })

  const output = interceptor(req, ctx, () => Promise.resolve("terminal"))

  expect(transformCalls).toBe(1)
  expect(await output).toBe("terminal")
})

test("beforeRequest rejects a normalization throw without calling next", async () => {
  const error = new Error("normalization failed")
  let nextCalls = 0
  const interceptor = beforeRequest<Ctx, Req, string>(() => {
    throw error
  })

  const output = interceptor({ payload: { value: 1 } }, ctx, () => {
    nextCalls++
    return Promise.resolve("terminal")
  })

  expect(nextCalls).toBe(0)
  await expect(output).rejects.toBe(error)
})

test("beforeRequest normalizes each reentry after an outer payload replacement", async () => {
  const initialPayload = { value: 1 }
  const replacementPayload = { value: 10 }
  const req: Req = { payload: initialPayload }
  const normalizedPayloads: Req["payload"][] = []
  const terminalValues: number[] = []
  const trace: string[] = []
  const outer: Interceptor<Ctx, Req, number> = async (current, _ctx, next) => {
    const first = await next()
    expect(first).toBe(2)
    current.payload = replacementPayload
    return next()
  }
  const normalizer = beforeRequest<Ctx, Req, number>((current) => {
    expect(current).toBe(req)
    normalizedPayloads.push(current.payload)
    trace.push(`normalize:${current.payload.value}`)
    current.payload.value++
  })

  const output = await runInterceptors(req, ctx, [outer, normalizer], () => {
    terminalValues.push(req.payload.value)
    trace.push(`terminal:${req.payload.value}`)
    return Promise.resolve(req.payload.value)
  })

  expect(normalizedPayloads).toHaveLength(2)
  expect(normalizedPayloads[0]).toBe(initialPayload)
  expect(normalizedPayloads[1]).toBe(replacementPayload)
  expect(terminalValues).toEqual([2, 11])
  expect(trace).toEqual(["normalize:1", "terminal:2", "normalize:10", "terminal:11"])
  expect(output).toBe(11)
})

test("beforeRequest rejects a synchronous downstream throw with the original error", async () => {
  const error = new Error("downstream threw")
  let transformCalls = 0
  let nextCalls = 0
  const interceptor = beforeRequest<Ctx, Req, string>(() => {
    transformCalls++
  })

  const output = interceptor({ payload: { value: 1 } }, ctx, () => {
    nextCalls++
    throw error
  })

  expect(transformCalls).toBe(1)
  expect(nextCalls).toBe(1)
  await expect(output).rejects.toBe(error)
})

test("beforeRequest preserves an already-rejected downstream promise and its error", async () => {
  const error = new Error("downstream rejected")
  const terminalPromise = Promise.reject<string>(error)
  let transformCalls = 0
  let nextCalls = 0
  const interceptor = beforeRequest<Ctx, Req, string>(() => {
    transformCalls++
  })

  const output = interceptor({ payload: { value: 1 } }, ctx, () => {
    nextCalls++
    return terminalPromise
  })

  await expect(output).rejects.toBe(error)
  expect(transformCalls).toBe(1)
  expect(nextCalls).toBe(1)
  expect(output).toBe(terminalPromise)
})
