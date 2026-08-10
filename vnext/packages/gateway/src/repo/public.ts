/**
 * 宿主面向的 repo 契约。与 `./index.ts` 分开是有意的：index.ts 是网关内部的
 * 桶，被上百处 `getRepo()` 调用点导入；如果把 `buildSharedRepo` 挂上去，
 * 那 1000+ 行的 repos.ts 就会进入每一个内部模块的依赖图。
 *
 * 宿主只需要三件事：Repo 的形状、SqlExecutor 的形状、以及把两者拼起来的
 * builder。具体的 D1Repo / BunSqliteRepo 只有宿主写得出来。
 */
export { initRepo } from './index.ts'
export type { Repo } from './types.ts'
export type { SqlExecutor } from './shared/executor.ts'
export { buildSharedRepo } from './shared/repos.ts'
