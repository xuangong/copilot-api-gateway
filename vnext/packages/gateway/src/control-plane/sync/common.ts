export class SyncError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

export const syncJson = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
})

/** Known errors keep their code; anything else is a uniform transient failure that leaks nothing. */
export function syncFailure(error: unknown): Response {
  if (error instanceof SyncError) return syncJson({ error: { code: error.code } }, error.status)
  return syncJson({ error: { code: "temporarily_unavailable" } }, 503)
}

/** Reads at most `maxBytes` of UTF-8 JSON. */
export async function readJsonBody(request: Request, maxBytes = 16_384): Promise<unknown> {
  if (!request.body) throw new SyncError("invalid_request", 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new SyncError("body_too_large", 413)
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }
  catch { throw new SyncError("invalid_request", 400) }
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")
}

export const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("")
