/**
 * TEMPORARY: relocated to @vnext/platform-bun in plan A3 T4. This re-export
 * keeps `entry-bun.ts` and `tests/_setup-platform.ts` building until T9
 * rewires every consumer to import from
 * `@vnext/platform-bun/src/memory-image-processor.ts` directly, at which
 * point this residual file is deleted.
 *
 * Why a relative path: gateway cannot workspace-depend on platform-bun (it
 * would invert the dependency direction), so the @vnext/platform-bun
 * subpath strategy used by platform-cloudflare in T3 doesn't work here.
 */
export { createInMemoryImageProcessor } from "../../../../../apps/platform-bun/src/memory-image-processor.ts"
