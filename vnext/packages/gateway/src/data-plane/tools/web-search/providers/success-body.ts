import { DEFAULT_WEB_SEARCH_CAPACITY_POLICY, WebSearchCapacityError, type WebSearchIngress } from "../capacity.ts"

interface SuccessBodyRequest {
  signal?: AbortSignal
  ingress?: WebSearchIngress
}

const BLOCK_BYTES = 16 * 1024

// Blocks are allocated only as admitted bytes arrive. No network chunk views
// survive a read, including views backed by a much larger runtime allocation.
export const readSuccessfulText = async (
  response: Response,
  request: SuccessBodyRequest = {},
  responseBodyBytes = request.ingress?.responseBodyBytes ?? DEFAULT_WEB_SEARCH_CAPACITY_POLICY.responseBodyBytes,
): Promise<string> => {
  request.ingress?.assertOpen()
  request.signal?.throwIfAborted()
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const blocks: Uint8Array[] = []
  let total = 0
  let current: Uint8Array | undefined
  let used = 0
  let rejectAbort: (reason: unknown) => void = () => undefined
  const cancel = (reason: unknown): void => {
    try { void reader.cancel(reason).catch(() => undefined) } catch { /* cancellation is best effort */ }
  }
  const onAbort = (): void => {
    cancel(request.signal?.reason)
    rejectAbort(request.signal?.reason)
  }
  request.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    while (true) {
      request.ingress?.assertOpen()
      request.signal?.throwIfAborted()
      // One abort waiter per active read. Reusing an unresolved abort promise
      // would retain one Promise.race reaction for every tiny network chunk.
      const abort = new Promise<never>((_, reject) => { rejectAbort = reject })
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try { chunk = await Promise.race([reader.read(), abort]) }
      finally { rejectAbort = () => undefined }
      request.ingress?.assertOpen()
      request.signal?.throwIfAborted()
      if (chunk.done) break
      const bytes = chunk.value.byteLength
      if (bytes > responseBodyBytes - total) throw new WebSearchCapacityError("responseBodyBytes", responseBodyBytes)
      request.ingress?.debit(bytes)
      total += bytes
      let offset = 0
      while (offset < bytes) {
        if (current === undefined || used === current.length) {
          current = new Uint8Array(Math.min(BLOCK_BYTES, responseBodyBytes - (total - bytes + offset)))
          blocks.push(current)
          used = 0
        }
        const take = Math.min(bytes - offset, current.length - used)
        current.set(chunk.value.subarray(offset, offset + take), used)
        used += take
        offset += take
      }
    }
    // Parsing/decoding only follows admitted EOF; split UTF-8 sequences span blocks.
    const decoder = new TextDecoder()
    const text = blocks.map((block, index) => decoder.decode(index === blocks.length - 1 ? block.subarray(0, used) : block, { stream: true }))
    text.push(decoder.decode())
    return text.join("")
  } catch (error) {
    if (error instanceof WebSearchCapacityError) request.ingress?.fail(error)
    cancel(error)
    throw error
  } finally {
    request.signal?.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
}

export const readSuccessfulJson = async (response: Response, request: SuccessBodyRequest = {}): Promise<unknown> => {
  const text = await readSuccessfulText(response, request)
  request.ingress?.assertOpen()
  request.signal?.throwIfAborted()
  return JSON.parse(text) as unknown
}
