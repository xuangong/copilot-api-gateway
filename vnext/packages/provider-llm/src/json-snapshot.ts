export interface JsonSnapshotObject { readonly [key: string]: JsonSnapshot }
export type JsonSnapshot = null | string | number | boolean | readonly JsonSnapshot[] | JsonSnapshotObject

type Container = JsonSnapshot[] | Record<string, JsonSnapshot>
type Frame = {
  source: object
  target: Container
  keys: readonly string[]
  index: number
  array: boolean
}

const normalizeScalar = (value: unknown): JsonSnapshot | undefined => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (value === undefined) return undefined
  if (typeof value !== "object") throw new TypeError("Unsupported known JSON value")
  return undefined
}

const assertKnownContainer = (value: object): void => {
  const prototype = Object.getPrototypeOf(value)
  const expected = Array.isArray(value) ? Array.prototype : Object.prototype
  if (prototype !== expected && !(expected === Object.prototype && prototype === null)) {
    throw new TypeError("Exotic object in known JSON data")
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("Accessor in known JSON data")
    }
    if (["function", "symbol", "bigint"].includes(typeof descriptor.value)) {
      throw new TypeError("Unsupported value in known JSON data")
    }
  }
}

// Internal copier for known generated data. It is not an eligibility test for arbitrary input.
export function snapshotKnownData(source: unknown): JsonSnapshot {
  if (source === undefined) throw new TypeError("No JSON representation")
  const rootScalar = normalizeScalar(source)
  if (rootScalar !== undefined) return rootScalar
  if (source === null || typeof source !== "object") throw new TypeError("Unsupported known JSON root")
  assertKnownContainer(source)

  const root: Container = Array.isArray(source) ? new Array<JsonSnapshot>(source.length) : Object.create(null) as Record<string, JsonSnapshot>
  const ancestors = new Set<object>([source])
  const frames: Frame[] = [{ source, target: root, keys: Array.isArray(source) ? [] : Object.keys(source), index: 0, array: Array.isArray(source) }]
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]
    if (frame === undefined) break
    const limit = frame.array ? (frame.target as JsonSnapshot[]).length : frame.keys.length
    if (frame.index >= limit) {
      Object.freeze(frame.target)
      ancestors.delete(frame.source)
      frames.pop()
      continue
    }
    const key = frame.array ? String(frame.index++) : frame.keys[frame.index++]
    if (key === undefined) throw new TypeError("Missing known JSON key")
    const descriptor = Object.getOwnPropertyDescriptor(frame.source, key)
    if (descriptor !== undefined && !("value" in descriptor)) throw new TypeError("Accessor in known JSON data")
    const value = descriptor?.value
    if (value === undefined && !frame.array) continue
    const scalar = normalizeScalar(value)
    let copy: JsonSnapshot
    if (scalar !== undefined) {
      copy = scalar
    } else if (value === undefined) {
      copy = null
    } else {
      if (value === null || typeof value !== "object") throw new TypeError("Unsupported known JSON value")
      if (ancestors.has(value)) throw new TypeError("Circular known JSON data")
      assertKnownContainer(value)
      copy = Array.isArray(value) ? new Array<JsonSnapshot>(value.length) : Object.create(null) as Record<string, JsonSnapshot>
      ancestors.add(value)
      frames.push({ source: value, target: copy as Container, keys: Array.isArray(value) ? [] : Object.keys(value), index: 0, array: Array.isArray(value) })
    }
    if (frame.array) (frame.target as JsonSnapshot[])[Number(key)] = copy
    else Object.defineProperty(frame.target, key, { value: copy, enumerable: true, configurable: false, writable: false })
  }
  return root
}
