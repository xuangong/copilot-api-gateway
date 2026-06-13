import { __registerPlatformReset } from "./reset.ts"

export interface PutOpts {
  contentType?: string
  metadata?: Record<string, string>
}
export interface FileGetResult {
  body: ReadableStream
  size?: number
  contentType?: string
}
export interface FileProvider {
  put(key: string, body: ReadableStream | Uint8Array | string, opts?: PutOpts): Promise<void>
  get(key: string): Promise<FileGetResult | null>
  delete(key: string): Promise<void>
  list?(prefix: string): Promise<string[]>
}

let _fp: FileProvider | null = null
__registerPlatformReset(() => { _fp = null })

export function initFileProvider(fp: FileProvider): void {
  _fp = fp
}

export function getFileProvider(): FileProvider {
  if (!_fp) throw new Error("FileProvider not initialized; call bootstrap*Platform() first")
  return _fp
}
