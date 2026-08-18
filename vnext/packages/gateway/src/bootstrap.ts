/**
 * 宿主装配面。网关的各个子系统靠运行时注入的适配器工作，这个桶把所有注入
 * 点收在一处，宿主不必知道 cache / responses-store / dump 各自住在哪一层。
 *
 * 这层间接不是装饰：上一轮把 shared/ 拆回两个平面时，apps/ 的 import 路径
 * 被迫跟着改了七个文件。有了这个桶，内部搬家不再穿透到宿主。
 */
import { getFileProvider, getSqlDatabase } from '@vibe-core/platform'
import { initDumpBroker, initDumpStore } from './shared/dump/registry.ts'
import { FileDumpStore } from './repo/dump-store.ts'
import { dumpCodec } from './shared/dump/codec.ts'
import { EventTargetChannelBroker } from './shared/runtime/event-target-channel-broker.ts'

export { initCache } from './data-plane/cache/index.ts'
export { initResponsesStore } from './data-plane/runtime/responses-store.ts'
export { initResend } from './control-plane/lib/email.ts'
export { initOAuthKV } from './control-plane/auth/stores.ts'

/**
 * 装配 dump 子系统（Spec 14）。存储走 SqlDatabase + FileProvider，broker 是
 * 进程内的（Bun 每容器一个，CFW 每 isolate 一个；跨 isolate 重放靠客户端
 * 重连后 list() 对账）。
 *
 * 零参数是有意的：两个宿主唯一的差异是 FileProvider 的实现，而那个差异已经
 * 由 initFileProvider 表达过了，再让宿主传一遍只会多一处可以写歪的地方。
 * 必须在 initSqlDatabase / initFileProvider 之后调用 —— 漏了会在启动时抛，
 * 不会静默降级。
 */
export function initDumpSubsystem(): void {
  initDumpStore(new FileDumpStore(getSqlDatabase(), getFileProvider()))
  initDumpBroker(new EventTargetChannelBroker(dumpCodec))
}
