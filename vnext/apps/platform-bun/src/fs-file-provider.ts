// vnext/apps/platform-bun/src/fs-file-provider.ts
/**
 * Filesystem-backed FileProvider for the Bun runtime. Ported 1:1 from
 * copilot-gateway `apps/platform-node/src/fs-file-provider.ts`, adapted to
 * the vNext FileProvider surface (streaming get, opts on put).
 *
 * Threat model: `root` is gateway-trusted. Bodies are stored verbatim; OS
 * confidentiality boundary belongs to the operator (umask, mount perms).
 */
import { mkdirSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import type { FileGetResult, FileProvider, PutOpts } from '@vibe-core/platform'

export class FsFileProvider implements FileProvider {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true })
  }

  async put(key: string, body: ReadableStream | Uint8Array | string, _opts?: PutOpts): Promise<void> {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    const bytes = typeof body === 'string'
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? body
        : new Uint8Array(await new Response(body).arrayBuffer())
    await writeFile(path, bytes)
  }

  async get(key: string): Promise<FileGetResult | null> {
    try {
      const bytes = new Uint8Array(await readFile(this.pathFor(key)))
      return {
        body: new Blob([bytes as unknown as ArrayBuffer]).stream(),
        size: bytes.byteLength,
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true })
  }

  // Reject `..`-laden keys so the FileProvider contract's opaque-key semantics
  // don't accidentally walk to arbitrary host paths.
  private pathFor(key: string): string {
    if (isAbsolute(key)) throw new Error(`FsFileProvider: absolute keys are not supported (${key})`)
    const path = resolve(this.root, ...key.split('/'))
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`FsFileProvider: key escapes root (${key})`)
    }
    return path
  }
}
