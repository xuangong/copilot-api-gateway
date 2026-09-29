import { expect, spyOn, test } from "bun:test"
import { fetchAffinityUpstream } from "../../src/data-plane/shared/affinity-request.ts"
import { analyzeAffinityRequest } from "../../src/shared/affinity/analysis.ts"
import type { ProviderRequest, ProviderResponse } from "@vibe-llm/provider-llm"
import type { RequestAffinity } from "../../src/shared/affinity/context.ts"
const state = async (): Promise<RequestAffinity> => ({ protocol: "responses", analysis: await analyzeAffinityRequest("responses", {}) })
const request = (signal: AbortSignal): ProviderRequest => ({ endpoint: "responses", payload: {}, headers: new Headers(), signal })
const response = (body: ReadableStream<Uint8Array> | null): ProviderResponse => ({ status: 200, headers: new Headers(), body })

test("body rejection aborts only its owned transport and detaches caller listener", async () => {
  const caller = new AbortController()
  const remove = spyOn(caller.signal, "removeEventListener")
  let transport: AbortSignal | undefined
  let abortedAtCancel = false
  const result = await fetchAffinityUpstream(await state(), request(caller.signal), async req => {
    transport = req.signal
    return response(new ReadableStream({ cancel() { abortedAtCancel = transport?.aborted === true } }))
  })
  await result.body?.cancel("invalid state")
  expect(transport?.aborted).toBe(true)
  expect(abortedAtCancel).toBe(true)
  expect(caller.signal.aborted).toBe(false)
  expect(remove).toHaveBeenCalledTimes(1)
  remove.mockRestore()
})

for (const completion of ["eof", "body-error", "fetch-error", "empty"] as const) test(`transport ${completion} releases its caller listener`, async () => {
  const caller = new AbortController()
  const remove = spyOn(caller.signal, "removeEventListener")
  let transport: AbortSignal | undefined
  const result = fetchAffinityUpstream(await state(), request(caller.signal), async req => {
    transport = req.signal
    if (completion === "fetch-error") throw new Error("fetch failed")
    return response(completion === "empty" ? null : new ReadableStream({ start(controller) {
      if (completion === "body-error") controller.error(new Error("body failed"))
      else controller.close()
    } }))
  })
  if (completion === "fetch-error") await expect(result).rejects.toThrow("fetch failed")
  else {
    const body = (await result).body
    if (completion === "body-error") await expect(new Response(body).text()).rejects.toThrow("body failed")
    else if (body) await new Response(body).text()
  }
  expect(remove).toHaveBeenCalledTimes(1)
  expect(caller.signal.aborted).toBe(false)
  const before = transport?.aborted
  caller.abort()
  expect(transport?.aborted).toBe(before)
  remove.mockRestore()
})

test("caller disconnect still reaches active transport and no-context requests retain signal identity", async () => {
  const caller = new AbortController()
  let transport: AbortSignal | undefined
  const result = await fetchAffinityUpstream(await state(), request(caller.signal), async req => {
    transport = req.signal
    return response(new ReadableStream())
  })
  caller.abort()
  expect(transport?.aborted).toBe(true)
  await result.body?.cancel()
  await fetchAffinityUpstream(undefined, request(caller.signal), async req => {
    expect(req.signal).toBe(caller.signal)
    return response(null)
  })
})
