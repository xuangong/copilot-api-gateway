import {
  initSqlDatabase,
  initEnv,
  initBackground,
  initRuntimeLocation,
  initImageProcessor,
  initFileProvider,
  initSocketDial,
  type SqlDatabase,
} from "@vibe-core/platform"
import { initRepo } from "@vibe-llm/gateway/repo"
import {
  initCache,
  initResponsesStore,
  initDumpBroker,
  initDumpStore,
  FileDumpStore,
  dumpCodec,
  EventTargetChannelBroker,
} from "@vibe-llm/gateway/bootstrap"
import { D1Repo } from "./d1-repo.ts"
import {
  createCloudflareImageProcessor,
  type ImagesBinding,
  type ImageCacheKv,
} from "./cloudflare-image-processor.ts"
import { createCloudflareCache } from "./cache-factory.ts"
import { createD1ResponsesStore } from "./responses-store-factory.ts"
import { R2FileProvider, type R2BucketLike } from "./r2-file-provider.ts"
import { cloudflareSocketDial } from "./cfw-socket-dial.ts"

export interface CloudflareEnv {
  DB: D1Database
  KV: KVNamespace
  IMAGE_CACHE: KVNamespace
  IMAGES: ImagesBinding
  FILES: R2BucketLike
  ACCOUNT_TYPE?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  CACHE_BACKEND?: string
}

let _booted = false

export function bootstrapCloudflarePlatform(env: CloudflareEnv, ctx: ExecutionContext): void {
  if (_booted) return
  if (!env.DB) throw new Error("CFW bootstrap: env.DB binding missing")
  if (!env.KV) throw new Error("CFW bootstrap: env.KV binding missing")
  if (!env.IMAGES) throw new Error("CFW bootstrap: env.IMAGES binding missing")
  if (!env.FILES) throw new Error("CFW bootstrap: env.FILES (R2) binding missing")

  initSqlDatabase(env.DB as unknown as SqlDatabase)
  initEnv((name) => String((env as unknown as Record<string, unknown>)[name] ?? ""))
  initBackground({ waitUntil: (p) => ctx.waitUntil(p) })
  initRuntimeLocation('cloudflare')
  initImageProcessor(
    createCloudflareImageProcessor(env.IMAGES, env.IMAGE_CACHE as unknown as ImageCacheKv),
  )
  initSocketDial(cloudflareSocketDial)
  const files = new R2FileProvider(env.FILES)
  initFileProvider(files)
  initRepo(new D1Repo(env.DB))
  initCache(createCloudflareCache({ DB: env.DB, KV: env.KV, CACHE_BACKEND: env.CACHE_BACKEND }))
  initResponsesStore(createD1ResponsesStore(env.DB))
  // Dump subsystem (Spec 14). R2-backed store; broker is in-process
  // (per-isolate). Cross-isolate replay is deferred — clients reconnect and
  // reconcile via list().
  initDumpStore(new FileDumpStore(env.DB as unknown as SqlDatabase, files))
  initDumpBroker(new EventTargetChannelBroker(dumpCodec))
  _booted = true
}
