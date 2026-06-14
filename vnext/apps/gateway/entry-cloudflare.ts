import {
  initSqlDatabase,
  initImageProcessor,
  initEnv,
  initBackground,
  type SqlDatabase,
} from '@vnext/platform'
import { app, type Env } from './src/app.ts'
import { D1Repo } from './src/shared/repo/d1.ts'
import type { D1Database } from './src/shared/repo/d1.ts'
import { initRepo } from './src/shared/repo/index.ts'
import { initCache } from './src/shared/cache/index.ts'
import { createCacheFromEnv } from './src/shared/cache/factory.ts'
import {
  createCloudflareImageProcessor,
  type ImagesBinding,
  type ImageCacheKv,
} from './src/shared/image/cloudflare.ts'
import { initResponsesStore } from './src/shared/runtime/responses-store.ts'
import { createD1ResponsesStore } from './src/shared/runtime/responses-store-factory.ts'

interface CloudflareBindings {
  DB: D1Database
  KV: KVNamespace
  IMAGE_CACHE: KVNamespace
  IMAGES: ImagesBinding
  CACHE_BACKEND?: string
  [key: string]: unknown
}

let _booted = false

function bootstrap(env: CloudflareBindings, ctx: ExecutionContext): void {
  if (_booted) return
  initSqlDatabase(env.DB as unknown as SqlDatabase)
  initEnv((name) => String((env as Record<string, unknown>)[name] ?? ''))
  initBackground({ waitUntil: (p) => ctx.waitUntil(p) })
  initImageProcessor(createCloudflareImageProcessor(env.IMAGES, env.IMAGE_CACHE as unknown as ImageCacheKv))
  initRepo(new D1Repo(env.DB))
  initCache(createCacheFromEnv({ DB: env.DB, KV: env.KV }, { CACHE_BACKEND: env.CACHE_BACKEND }))
  initResponsesStore(createD1ResponsesStore(env.DB))
  _booted = true
}

export default {
  fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    bootstrap(env, ctx)
    return app.fetch(request, env as unknown as Env, ctx)
  },
} satisfies ExportedHandler<CloudflareBindings>
