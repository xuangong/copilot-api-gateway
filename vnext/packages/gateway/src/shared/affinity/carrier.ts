import { appendOpaqueTrailer, concatBytes, decodeOpaqueValue, encodeOpaqueValue, splitOpaqueTrailer } from "@vibe-llm/protocols/common"
import type { OpaqueValueOrigin } from "@vibe-llm/protocols/common"
import { parseAffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { ApiKeyAffinitySecret } from "../../repo/affinity-secret.ts"

export const AFFINITY_MARKER = "vnext-affinity:"
export const MAX_AFFINITY_PAYLOAD_BYTES = 1024 * 1024
export const MAX_AFFINITY_TRAILER_BYTES = 8192
export const MAX_AFFINITY_WIRE_CHARS = Math.ceil((MAX_AFFINITY_PAYLOAD_BYTES + MAX_AFFINITY_TRAILER_BYTES + 2) / 3) * 4 + 32
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const buffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer

export class InvalidAffinityStateError extends Error {
  readonly code = "invalid_affinity_state"
  readonly status = 400
  constructor() {
    super("Invalid authenticated opaque state")
    this.name = "InvalidAffinityStateError"
  }
}
export interface AffinityField {
  /** Stable protocol/item/field identifier, not an array position. */
  readonly domain: string
  /** Native v1 companion content, serialized canonically by the protocol adapter. */
  readonly block?: string
}
export type DecodedAffinity = { readonly kind: "foreign"; readonly value: string }
  | { readonly kind: "owned"; readonly value: string; readonly target: AffinityExecutionTarget; readonly synthetic: boolean }
  | { readonly kind: "origin"; readonly target: AffinityExecutionTarget; readonly syntheticItem: boolean }
export interface AffinityCodecOptions extends ApiKeyAffinitySecret {
  readonly ownerId: string
  readonly apiKeyId: string
  readonly sharedSecret?: Uint8Array
  readonly decorateTarget?: (target: AffinityExecutionTarget) => Promise<AffinityExecutionTarget>
}

function boundedField(field: AffinityField): void {
  if (!field.domain || field.domain.length > 512 || (field.block?.length ?? 0) > MAX_AFFINITY_PAYLOAD_BYTES) throw new InvalidAffinityStateError()
}

function validateOriginField(field: AffinityField, syntheticItem: unknown): void {
  const expected = field.domain === "responses/reasoning/encrypted_content" || field.domain === "messages/redacted_thinking/data"
    ? true : field.domain === "chat_completions/reasoning/reasoning_opaque" || field.domain === "gemini/part/thoughtSignature" ? false : undefined
  if (expected === undefined || syntheticItem !== expected) throw new InvalidAffinityStateError()
}

/** A recognizable outer marker makes corrupt/unknown gateway state fail closed.
 * The existing opaque codec retains raw UTF-16 and canonical base64 origins. */
export class AffinityCodec {
  readonly #key: Promise<CryptoKey>
  readonly #sharedKey?: Promise<CryptoKey>
  readonly #decorateTarget?: AffinityCodecOptions["decorateTarget"]
  readonly #binding: readonly string[]
  constructor(options: AffinityCodecOptions) {
    if (options.version !== 1 || options.secret.length !== 32
      || [options.ownerId, options.apiKeyId, options.keyId].some(value => !value || value.length > 512)) throw new InvalidAffinityStateError()
    if (options.sharedSecret && options.sharedSecret.length !== 32) throw new InvalidAffinityStateError()
    this.#decorateTarget = options.sharedSecret ? options.decorateTarget : undefined
    if (options.sharedSecret) this.#sharedKey = crypto.subtle.importKey("raw", buffer(options.sharedSecret), "HKDF", false, ["deriveKey"]).then(key => crypto.subtle.deriveKey({
      name: "HKDF", hash: "SHA-256", salt: encoder.encode("vnext/shared-session/v1"), info: encoder.encode("opaque-carrier/aes-gcm/v1"),
    }, key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]))
    this.#binding = [options.ownerId, options.apiKeyId, options.keyId]
    this.#key = crypto.subtle.importKey("raw", buffer(options.secret), "HKDF", false, ["deriveKey"]).then(key => crypto.subtle.deriveKey({
      name: "HKDF", hash: "SHA-256", salt: encoder.encode("vnext/api-key-affinity/v1"), info: encoder.encode("opaque-carrier/aes-gcm/v1"),
    }, key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]))
  }

  async targetForSharing(target: AffinityExecutionTarget): Promise<AffinityExecutionTarget> {
    return this.#decorateTarget ? this.#decorateTarget(target) : target
  }

  private aad(field: AffinityField, original: Uint8Array, shared = false): ArrayBuffer {
    boundedField(field)
    // JSON escapes lone UTF-16 surrogates before UTF-8 encoding the binding.
    return buffer(concatBytes(encoder.encode(JSON.stringify([...(shared ? ["v3"] : ["v1", ...this.#binding]), field.domain, field.block ?? null])), original))
  }

  private originAad(field: AffinityField, shared = false): ArrayBuffer {
    // Provenance authenticates its producer, not client-assembled visible text.
    // Native v1 state continues to bind its original bytes and companion content.
    return buffer(encoder.encode(JSON.stringify([...(shared ? ["v4"] : ["v2", ...this.#binding]), field.domain])))
  }

  async encodeOrigin(target: AffinityExecutionTarget, field: AffinityField, options: { syntheticItem: boolean }): Promise<string> {
    validateOriginField(field, options.syntheticItem)
    const version = this.#sharedKey ? 4 : 2
    const metadata = encoder.encode(JSON.stringify({ version, target: parseAffinityExecutionTarget(this.#decorateTarget ? await this.#decorateTarget(target) : target), syntheticItem: options.syntheticItem }))
    if (metadata.length + 28 > MAX_AFFINITY_TRAILER_BYTES) throw new InvalidAffinityStateError()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.originAad(field, version === 4) }, await (this.#sharedKey ?? this.#key), buffer(metadata)))
    return `${AFFINITY_MARKER}${version}:${appendOpaqueTrailer(undefined, concatBytes(iv, encrypted))}`
  }

  async encode(value: string, target: AffinityExecutionTarget, field: AffinityField, options: { synthetic?: boolean } = {}): Promise<string> {
    boundedField(field)
    if (value.length > MAX_AFFINITY_PAYLOAD_BYTES) throw new InvalidAffinityStateError()
    const original = decodeOpaqueValue(value)
    if (original.bytes.length > MAX_AFFINITY_PAYLOAD_BYTES) throw new InvalidAffinityStateError()
    const version = this.#sharedKey ? 3 : 1
    const metadata = encoder.encode(JSON.stringify({ version, origin: original.origin, target: parseAffinityExecutionTarget(this.#decorateTarget ? await this.#decorateTarget(target) : target), synthetic: options.synthetic === true }))
    if (metadata.length + 28 > MAX_AFFINITY_TRAILER_BYTES) throw new InvalidAffinityStateError()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.aad(field, original.bytes, version === 3) }, await (this.#sharedKey ?? this.#key), buffer(metadata)))
    return `${AFFINITY_MARKER}${version}:${appendOpaqueTrailer(original, concatBytes(iv, encrypted))}`
  }

  async decode(value: string, field: AffinityField): Promise<DecodedAffinity> {
    if (!value.startsWith(AFFINITY_MARKER)) return { kind: "foreign", value }
    try {
      const version = Number(value.slice(AFFINITY_MARKER.length, AFFINITY_MARKER.length + 1))
      if (![1, 2, 3, 4].includes(version) || value[AFFINITY_MARKER.length + 1] !== ":") throw new InvalidAffinityStateError()
      const shared = version === 3 || version === 4
      const key = shared ? this.#sharedKey : this.#key
      if (!key) throw new InvalidAffinityStateError()
      if (version === 2 || version === 4) {
        // No native payload is permitted in an origin-only frame.
        if (value.length > Math.ceil((MAX_AFFINITY_TRAILER_BYTES + 2) / 3) * 4 + AFFINITY_MARKER.length + 2) throw new InvalidAffinityStateError()
        const split = splitOpaqueTrailer(value.slice(AFFINITY_MARKER.length + 2), 28)
        if (!split || split.original.length !== 0 || split.trailer.length > MAX_AFFINITY_TRAILER_BYTES) throw new InvalidAffinityStateError()
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(split.trailer.subarray(0, 12)), additionalData: this.originAad(field, shared) }, await key, buffer(split.trailer.subarray(12)))
        const data: unknown = JSON.parse(decoder.decode(plain))
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new InvalidAffinityStateError()
        const parsed = data as Record<string, unknown>
        if (Object.keys(parsed).some(key => !["version", "target", "syntheticItem"].includes(key)) || parsed.version !== version) throw new InvalidAffinityStateError()
        validateOriginField(field, parsed.syntheticItem)
        return { kind: "origin", target: parseAffinityExecutionTarget(parsed.target), syntheticItem: parsed.syntheticItem as boolean }
      }
      boundedField(field)
      if (value.length > MAX_AFFINITY_WIRE_CHARS) throw new InvalidAffinityStateError()
      const split = splitOpaqueTrailer(value.slice(AFFINITY_MARKER.length + 2), 28)
      if (!split || split.original.length > MAX_AFFINITY_PAYLOAD_BYTES || split.trailer.length > MAX_AFFINITY_TRAILER_BYTES) throw new InvalidAffinityStateError()
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(split.trailer.subarray(0, 12)), additionalData: this.aad(field, split.original, shared) }, await key, buffer(split.trailer.subarray(12)))
      const data: unknown = JSON.parse(decoder.decode(plain))
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new InvalidAffinityStateError()
      const parsed = data as Record<string, unknown>
      if (Object.keys(parsed).some(key => !["version", "origin", "target", "synthetic"].includes(key)) || parsed.version !== version
        || (parsed.origin !== "raw" && parsed.origin !== "base64" && parsed.origin !== "base64url") || typeof parsed.synthetic !== "boolean") throw new InvalidAffinityStateError()
      const origin: OpaqueValueOrigin = parsed.origin
      return { kind: "owned", value: encodeOpaqueValue(split.original, origin), target: parseAffinityExecutionTarget(parsed.target), synthetic: parsed.synthetic }
    } catch {
      // Never expose crypto/parser internals or downgrade an owned marker to foreign.
      throw new InvalidAffinityStateError()
    }
  }
}
