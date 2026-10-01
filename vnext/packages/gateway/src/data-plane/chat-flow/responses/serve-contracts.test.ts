import type { ResponsesPreparedObserver, ResponsesServeArgs } from "./serve.ts"
import type { PreparedModelIdentity, kitDeps } from "../shared/kit-deps.ts"

type Assert<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Writable<T> = { -readonly [K in keyof T]: T[K] }
type Observer = NonNullable<ResponsesServeArgs["onPrepared"]>
type ObservedPayload = Parameters<Observer>[0]

type _NamedObserverExact = Assert<Equal<Observer, ResponsesPreparedObserver>>
type _TelemetryPreparedExtraExact = Assert<Equal<Parameters<typeof kitDeps.buildTelemetryCtx>[0]["extra"], PreparedModelIdentity>>
type _AsyncObserverRejected = Assert<(() => Promise<undefined>) extends Observer ? false : true>
type _VoidObserverRejected = Assert<(() => void) extends Observer ? false : true>
type _SyncObserverAccepted = Assert<(() => undefined) extends Observer ? true : false>
type _PayloadViewExact = Assert<Equal<ObservedPayload, Readonly<Record<string, unknown>>>>
type _PayloadViewReadonly = Assert<Equal<ObservedPayload, Writable<ObservedPayload>> extends true ? false : true>
