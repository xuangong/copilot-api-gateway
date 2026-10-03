type Input = Record<string, unknown>
interface CapturedInput { snapshot: Input; plain: boolean }

function container(value: object): object | undefined {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (Array.isArray(value)) return prototype === Array.prototype ? new Array<unknown>(value.length) : undefined
  return prototype === Object.prototype || prototype === null ? {} : undefined
}

function captureInput(source: Readonly<Input>): CapturedInput {
  const root = container(source)
  if (!root) return { snapshot: structuredClone(source), plain: false }
  const copies = new Map<object, object>([[source, root]])
  const pending = [{ source: source as object, target: root }]
  while (pending.length) {
    const entry = pending.pop()
    if (!entry) break
    for (const key of Object.keys(entry.source)) {
      const descriptor = Object.getOwnPropertyDescriptor(entry.source, key)
      if (!descriptor || !("value" in descriptor)) return { snapshot: structuredClone(source), plain: false }
      const value: unknown = descriptor.value
      if (typeof value === "symbol" || typeof value === "function") return { snapshot: structuredClone(source), plain: false }
      let copied: unknown = value
      if (typeof value === "object" && value !== null) {
        let target = copies.get(value)
        if (!target) {
          target = container(value)
          if (!target) return { snapshot: structuredClone(source), plain: false }
          copies.set(value, target)
          pending.push({ source: value, target })
        }
        copied = target
      }
      // Assignment would interpret an own JSON "__proto__" as a setter.
      Object.defineProperty(entry.target, key, { value: copied, enumerable: true, configurable: true, writable: true })
    }
  }
  return { snapshot: root as Input, plain: true }
}

/** Affinity input comes from HTTP/WS JSON parsing (including restored JSON
 * continuations). Copy mutable containers without serializing immutable strings
 * again. Runtime-only objects/accessors retain the native structured-clone path;
 * inspect descriptors so fallback never executes an accessor twice. */
export function cloneAffinityInput(source: Readonly<Input>): Input {
  return captureInput(source).snapshot
}

function plainContainer(value: object): object {
  return Array.isArray(value) ? new Array<unknown>(value.length) : {}
}

// Only the bound factory closure passes a completed, private plain capture here.
// Every consumer still owns new containers; normalization does not permit sharing.
function clonePlainSnapshot(source: Readonly<Input>): Input {
  const root = plainContainer(source)
  const copies = new Map<object, object>([[source, root]])
  const pending = [{ source: source as object, target: root }]
  while (pending.length) {
    const entry = pending.pop()
    if (!entry) break
    for (const key of Object.keys(entry.source)) {
      const value = (entry.source as Input)[key]
      let copied: unknown = value
      if (typeof value === "object" && value !== null) {
        let target = copies.get(value)
        if (!target) {
          target = plainContainer(value)
          copies.set(value, target)
          pending.push({ source: value, target })
        }
        copied = target
      }
      Object.defineProperty(entry.target, key, { value: copied, enumerable: true, configurable: true, writable: true })
    }
  }
  return root as Input
}

/** Internal analysis ownership boundary: the snapshot view must remain private. */
export function captureAffinityInput(source: Readonly<Input>): { snapshot: Readonly<Input>; clone(): Input } {
  const { snapshot, plain } = captureInput(source)
  return {
    snapshot,
    clone: plain ? () => clonePlainSnapshot(snapshot) : () => cloneAffinityInput(snapshot),
  }
}
