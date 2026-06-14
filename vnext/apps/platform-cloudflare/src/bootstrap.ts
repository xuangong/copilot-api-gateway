import {
  initSqlDatabase,
  initImageProcessor,
  initEnv,
  initBackground,
  type SqlDatabase,
} from "@vnext/platform"
import { initRepo } from "@vnext/gateway/src/shared/repo/index.ts"
import { initCache } from "@vnext/gateway/src/shared/cache/index.ts"
import { initResponsesStore } from "@vnext/gateway/src/shared/runtime/responses-store.ts"
import { D1Repo } from "./d1-repo.ts"
import {
  createCloudflareImageProcessor,
  type ImagesBinding,
  type ImageCacheKv,
} from "./cloudflare-image-processor.ts"
import { createCloudflareCache } from "./cache-factory.ts"
import { createD1ResponsesStore } from "./responses-store-factory.ts"

export interface CloudflareEnv {
  DB: D1Database
  KV: KVNamespace
  IMAGE_CACHE: KVNamespace
  IMAGES: ImagesBinding
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

  initSqlDatabase(env.DB as unknown as SqlDatabase)
  initEnv((name) => String((env as unknown as Record<string, unknown>)[name] ?? ""))
  initBackground({ waitUntil: (p) => ctx.waitUntil(p) })
  initImageProcessor(
    createCloudflareImageProcessor(env.IMAGES, env.IMAGE_CACHE as unknown as ImageCacheKv),
  )
  initRepo(new D1Repo(env.DB))
  initCache(createCloudflareCache({ DB: env.DB, KV: env.KV, CACHE_BACKEND: env.CACHE_BACKEND }))
  initResponsesStore(createD1ResponsesStore(env.DB))
  _booted = true
}
