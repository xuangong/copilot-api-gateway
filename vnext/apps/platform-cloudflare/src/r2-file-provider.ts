// vnext/apps/platform-cloudflare/src/r2-file-provider.ts
/**
 * R2-backed FileProvider for the Cloudflare Worker runtime. Ported from
 * copilot-gateway `apps/platform-cloudflare/src/r2-file-provider.ts`, adapted
 * to vNext's streaming FileProvider surface.
 *
 * R2 caps `delete` at 1000 keys per call, so `deleteKeys` batches. The single-key
 * `delete(key)` here maps onto that path via a length-1 array.
 */
import type { FileGetResult, FileProvider, PutOpts } from '@vibe-core/platform'

export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>
    body: ReadableStream
    size: number
    httpMetadata?: { contentType?: string }
  } | null>
  delete(keys: string | string[]): Promise<void>
  list?(opts: { prefix: string; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>
}

export class R2FileProvider implements FileProvider {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, body: ReadableStream | Uint8Array | string, opts?: PutOpts): Promise<void> {
    const r2Opts = opts?.contentType || opts?.metadata
      ? { httpMetadata: opts?.contentType ? { contentType: opts.contentType } : undefined, customMetadata: opts?.metadata }
      : undefined
    await this.bucket.put(key, body as ReadableStream | ArrayBuffer | string, r2Opts)
  }

  async get(key: string): Promise<FileGetResult | null> {
    const object = await this.bucket.get(key)
    if (!object) return null
    return {
      body: object.body,
      size: object.size,
      contentType: object.httpMetadata?.contentType,
    }
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key)
  }

  async list(prefix: string): Promise<string[]> {
    if (!this.bucket.list) return []
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix, cursor })
      for (const obj of page.objects) keys.push(obj.key)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return keys
  }
}
