// Branded id types. Compile-time only — they erase to `string` at runtime.
// The unique-symbol brand makes different id kinds mutually incompatible so
// `apiKeys.getById(someUpstreamId)` fails at compile time.
//
// Construction is centralized in the repo layer's `fromRow` mappers (via the
// `as ApiKeyId` casts). Business code cannot mint branded ids — it can only
// receive them from the repo or from Zod `.transform()` at HTTP boundaries.

declare const __brand: unique symbol

export type ApiKeyId = string & { readonly [__brand]: 'ApiKeyId' }
export type DumpRecordId = string & { readonly [__brand]: 'DumpRecordId' }
export type UpstreamId = string & { readonly [__brand]: 'UpstreamId' }
export type UserId = string & { readonly [__brand]: 'UserId' }
export type ProxyId = string & { readonly [__brand]: 'ProxyId' }
export type InviteCodeId = string & { readonly [__brand]: 'InviteCodeId' }
export type SessionToken = string & { readonly [__brand]: 'SessionToken' }
export type DeviceCodeToken = string & { readonly [__brand]: 'DeviceCodeToken' }
export type ResponsesItemId = string & { readonly [__brand]: 'ResponsesItemId' }
