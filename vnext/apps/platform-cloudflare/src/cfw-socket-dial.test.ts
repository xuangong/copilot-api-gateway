import { expect, test } from "bun:test"
import { createCloudflareSocketDial, type CloudflareSocketLike } from "./cfw-socket-dial-core.ts"

const wording = "proxy request failed, cannot connect to the specified address"

const socketFor = (opened: Promise<void>, onClose: () => void): CloudflareSocketLike => ({
  opened,
  closed: opened,
  readable: new ReadableStream<Uint8Array>(),
  writable: new WritableStream<Uint8Array>(),
  close: async () => { onClose() },
})

test.each([wording, `${wording}: blocked`])("classifies opened rejection %s and retains cause", async message => {
  const original = new Error(message)
  let closes = 0
  const dial = createCloudflareSocketDial(() => socketFor(Promise.reject(original), () => closes++))
  let thrown: unknown
  try { await dial.connect("example.com", 443) } catch (error) { thrown = error }
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).cause).toBe(original)
  expect(dial.shouldConnectErrorFallbackToFetch?.(thrown)).toBe(true)
  expect(dial.shouldConnectErrorFallbackToFetch?.(original)).toBe(false)
  expect(closes).toBe(1)
})

test("unrelated opened rejection is never classified", async () => {
  const original = new Error("connection refused")
  const dial = createCloudflareSocketDial(() => socketFor(Promise.reject(original), () => {}))
  let thrown: unknown
  try { await dial.connect("example.com", 443) } catch (error) { thrown = error }
  expect((thrown as Error).cause).toBe(original)
  expect(dial.shouldConnectErrorFallbackToFetch?.(thrown)).toBe(false)
})

test("the opened rejection mark belongs only to its dial instance", async () => {
  const first = createCloudflareSocketDial(() => socketFor(Promise.reject(new Error(wording)), () => {}))
  const second = createCloudflareSocketDial(() => socketFor(Promise.resolve(), () => {}))
  let thrown: unknown
  try { await first.connect("example.com", 443) } catch (error) { thrown = error }
  expect(first.shouldConnectErrorFallbackToFetch?.(thrown)).toBe(true)
  expect(second.shouldConnectErrorFallbackToFetch?.(thrown)).toBe(false)
})

test("synchronous connect throw with the same wording is not classified", async () => {
  const dial = createCloudflareSocketDial(() => { throw new Error(wording) })
  let thrown: unknown
  try { await dial.connect("example.com", 443) } catch (error) { thrown = error }
  expect(dial.shouldConnectErrorFallbackToFetch?.(thrown)).toBe(false)
})

test("caller abort during opened rejection is not classified", async () => {
  const controller = new AbortController()
  let rejectOpened: ((error: Error) => void) | undefined
  const opened = new Promise<void>((_, reject) => { rejectOpened = reject })
  const dial = createCloudflareSocketDial(() => socketFor(opened, () => {}))
  const result = dial.connect("example.com", 443, { signal: controller.signal })
  controller.abort()
  rejectOpened?.(new Error(wording))
  let thrown: unknown
  try { await result } catch (error) { thrown = error }
  expect(dial.shouldConnectErrorFallbackToFetch?.(thrown)).toBe(false)
})
