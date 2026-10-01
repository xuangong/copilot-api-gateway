import type { ServerToolRequestCtx, ServerToolTerminal } from "../types"

type Assert<T extends true> = T
type _ReaderHasNoWriter = Assert<"registerPrivatePayload" extends keyof ServerToolRequestCtx["store"] ? false : true>
type _ReaderHasNoDisposer = Assert<"dispose" extends keyof ServerToolRequestCtx["store"] ? false : true>
type _TerminalRejectsPrimitive = Assert<string extends NonNullable<ServerToolTerminal["privatePayload"]> ? false : true>

import type { OwnedServerToolPrivatePayloadScope, ServerToolPrivatePayloadWriter } from "../private-payload-store"

type Writer = ServerToolPrivatePayloadWriter["registerPrivatePayload"]
type Disposer = OwnedServerToolPrivatePayloadScope["dispose"]
type _WriterHasNoReader = Assert<"getPrivatePayload" extends keyof ServerToolPrivatePayloadWriter ? false : true>
type _WriterHasNoDisposer = Assert<"dispose" extends keyof ServerToolPrivatePayloadWriter ? false : true>
type _WriterRejectsAsync = Assert<((...args: Parameters<Writer>) => Promise<void>) extends Writer ? false : true>
type _WriterRejectsBroadVoid = Assert<((...args: Parameters<Writer>) => void) extends Writer ? false : true>
type _DisposerRejectsAsync = Assert<(() => Promise<void>) extends Disposer ? false : true>
type _DisposerRejectsBroadVoid = Assert<(() => void) extends Disposer ? false : true>

import type { materializeServerToolItems } from "../../../chat-flow/responses/interceptors/server-tool-shim"

type MaterializerLifetime = Parameters<typeof materializeServerToolItems>[3]
type _MaterializerHasNoInvocationClose = Assert<"close" extends keyof MaterializerLifetime ? false : true>
type _MaterializerHasNoStateDisposer = Assert<"disposeState" extends keyof MaterializerLifetime ? false : true>
