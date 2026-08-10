/**
 * 宿主装配面。网关的各个子系统靠运行时注入的适配器工作，这个桶把所有注入
 * 点收在一处，宿主不必知道 cache / responses-store / dump 各自住在哪一层。
 *
 * 这层间接不是装饰：上一轮把 shared/ 拆回两个平面时，apps/ 的 import 路径
 * 被迫跟着改了七个文件。有了这个桶，内部搬家不再穿透到宿主。
 *
 * dumpCodec 与 EventTargetChannelBroker 是默认实现的零件，两个宿主传的值
 * 完全相同 —— 之所以仍然外露，是因为收回内部会改变装配逻辑，那是另一件事。
 */
export { initCache } from './data-plane/cache/index.ts'
export { initResponsesStore } from './data-plane/runtime/responses-store.ts'
export { initDumpStore, initDumpBroker } from './shared/dump/registry.ts'
export { FileDumpStore } from './repo/dump-store.ts'
export { dumpCodec } from './shared/dump/codec.ts'
export { EventTargetChannelBroker } from './shared/runtime/event-target-channel-broker.ts'
