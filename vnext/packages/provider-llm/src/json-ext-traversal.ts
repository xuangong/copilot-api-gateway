// Adapted from @discoveryjs/json-ext v1.1.0 src/stringify-chunked.js.
// Copyright (c) 2020-2026 Roman Dvornov. See vendor/json-ext-LICENSE.
import type { JsonSnapshot } from "./json-snapshot"

const MAX_CHUNK_BYTES = 65536
const MAX_SLICE_UNITS = 8192
const encoder = new TextEncoder()

type Frame = {
  value: readonly JsonSnapshot[] | Readonly<Record<string, JsonSnapshot>>
  keys: readonly string[]
  index: number
  empty: boolean
  array: boolean
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

export function* jsonSnapshotByteChunks(value: JsonSnapshot): Generator<Uint8Array> {
  let buffer = new Uint8Array(MAX_CHUNK_BYTES)
  let used = 0
  function* emitBytes(fragment: Uint8Array): Generator<Uint8Array> {
    if (fragment.byteLength > MAX_CHUNK_BYTES) throw new TypeError("Oversize JSON fragment")
    if (used + fragment.byteLength > MAX_CHUNK_BYTES) {
      yield buffer.slice(0, used)
      buffer = new Uint8Array(MAX_CHUNK_BYTES)
      used = 0
    }
    buffer.set(fragment, used)
    used += fragment.byteLength
  }
  function* emitToken(token: string): Generator<Uint8Array> {
    yield* emitBytes(encoder.encode(token))
  }
  function* emitString(text: string): Generator<Uint8Array> {
    yield* emitToken('"')
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + MAX_SLICE_UNITS)
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end++
      const quoted = JSON.stringify(text.slice(start, end))
      yield* emitBytes(encoder.encode(quoted.slice(1, -1)))
      start = end
    }
    yield* emitToken('"')
  }
  function* emitPrimitive(primitive: null | string | number | boolean): Generator<Uint8Array> {
    if (typeof primitive === "string") yield* emitString(primitive)
    else yield* emitToken(JSON.stringify(primitive))
  }

  const stack: Frame[] = []
  function* push(next: JsonSnapshot): Generator<Uint8Array> {
    if (next === null || typeof next !== "object") {
      yield* emitPrimitive(next)
      return
    }
    const array = Array.isArray(next)
    stack.push({ value: next, keys: array ? [] : Object.keys(next), index: 0, empty: true, array })
    yield* emitToken(array ? "[" : "{")
  }
  yield* push(value)
  while (stack.length > 0) {
    const state = stack[stack.length - 1]
    if (state === undefined) break
    const length = state.array ? (state.value as readonly JsonSnapshot[]).length : state.keys.length
    if (state.index === length) {
      yield* emitToken(state.array ? "]" : "}")
      stack.pop()
      continue
    }
    if (state.empty) state.empty = false
    else yield* emitToken(",")
    const key = state.array ? String(state.index++) : state.keys[state.index++]
    if (key === undefined) throw new TypeError("Missing snapshot key")
    if (!state.array) {
      yield* emitString(key)
      yield* emitToken(":")
    }
    const child = state.array ? (state.value as readonly JsonSnapshot[])[Number(key)] : (state.value as Readonly<Record<string, JsonSnapshot>>)[key]
    if (child === undefined) throw new TypeError("Invalid JSON snapshot")
    yield* push(child)
  }
  if (used > 0) yield buffer.slice(0, used)
}
