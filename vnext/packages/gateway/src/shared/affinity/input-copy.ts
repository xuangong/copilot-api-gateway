type Input = Record<string, unknown>

function container(value: object): object | undefined {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (Array.isArray(value)) return prototype === Array.prototype ? new Array<unknown>(value.length) : undefined
  return prototype === Object.prototype || prototype === null ? {} : undefined
}

/** Affinity input comes from HTTP/WS JSON parsing (including restored JSON
 * continuations). Copy mutable containers without serializing immutable strings
 * again. Runtime-only objects/accessors retain the native structured-clone path;
 * inspect descriptors so fallback never executes an accessor twice. */
export function cloneAffinityInput(source: Readonly<Input>): Input {
  const root = container(source)
  if (!root) return structuredClone(source)
  const copies = new Map<object, object>([[source, root]])
  const pending = [{ source: source as object, target: root }]
  while (pending.length) {
    const entry = pending.pop()
    if (!entry) break
    for (const key of Object.keys(entry.source)) {
      const descriptor = Object.getOwnPropertyDescriptor(entry.source, key)
      if (!descriptor || !("value" in descriptor)) return structuredClone(source)
      const value: unknown = descriptor.value
      if (typeof value === "symbol" || typeof value === "function") return structuredClone(source)
      let copied: unknown = value
      if (typeof value === "object" && value !== null) {
        let target = copies.get(value)
        if (!target) {
          target = container(value)
          if (!target) return structuredClone(source)
          copies.set(value, target)
          pending.push({ source: value, target })
        }
        copied = target
      }
      // Assignment would interpret an own JSON "__proto__" as a setter.
      Object.defineProperty(entry.target, key, { value: copied, enumerable: true, configurable: true, writable: true })
    }
  }
  return root as Input
}
