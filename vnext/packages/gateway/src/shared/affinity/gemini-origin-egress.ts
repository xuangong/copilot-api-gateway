import { InvalidAffinityStateError } from "./carrier.ts"

type JsonObject = Record<string, unknown>
type Part = JsonObject
type Candidate = JsonObject & { content: JsonObject & { parts: Part[] }; finishReason?: unknown }
type Stamp = (part: Part) => Promise<Part>
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value)
const partAt = (parts: readonly Part[], index: number): Part => {
  const part = parts[index]
  if (!part) throw new InvalidAffinityStateError()
  return part
}
const candidates = (event: JsonObject): Candidate[] => Array.isArray(event.candidates)
  ? event.candidates.filter((value): value is Candidate => object(value) && object(value.content) && Array.isArray(value.content.parts) && value.content.parts.every(object)) : []
export const hasGeminiAffinitySlot = (event: unknown): boolean => object(event) && !event.error
  && candidates(event).some(candidate => candidate.content.parts.some(part => typeof part.thoughtSignature === "string" || hasPartContent(part)))

/** One-event window adapted from the reference Gemini affinity egress. It can
 * move an immediate late signature onto real content without buffering a turn.
 * Earlier text keeps flowing unsigned while its logical element remains open.
 * Empty Parts cannot carry origin: Go GenAI Chat discards that whole turn. */
export class GeminiOriginEgress {
  private readonly anchored = new Set<number>()
  private readonly suppressed = new WeakSet<JsonObject>()
  constructor(private readonly natural: Stamp, private readonly origin: Stamp) {}

  async body<T>(body: T): Promise<T> {
    if (!object(body) || body.error) return body
    return await this.project(structuredClone(body), undefined, true) as T
  }

  async *stream(events: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    let pending: JsonObject | undefined
    const iterator = events[Symbol.asyncIterator]()
    let completed = false
    const flush = async (next?: JsonObject) => {
      if (!pending) return undefined
      const output = await this.project(pending, next, false)
      pending = undefined
      return this.suppressed.has(output) ? undefined : output
    }
    try {
      while (true) {
        let next: IteratorResult<unknown>
        try { next = await iterator.next() }
        catch (error) {
          const output = await flush()
          if (output) yield output
          throw error
        }
        if (next.done) { completed = true; break }
        if (!object(next.value) || next.value.error) {
          const output = await flush()
          if (output) yield output
          yield next.value
          if (object(next.value) && next.value.error) return
          continue
        }
        const current = structuredClone(next.value)
        const output = await flush(current)
        if (output) yield output
        pending = current
      }
      const output = await flush()
      if (output) yield output
    } finally { if (!completed) await iterator.return?.() }
  }

  private async project(current: JsonObject, next: JsonObject | undefined, terminal: boolean): Promise<JsonObject> {
    const currentCandidates = candidates(current)
    const nextCandidates = next ? candidates(next) : []
    const removed = new WeakSet<Candidate>()
    for (const [position, candidate] of currentCandidates.entries()) {
      const index = typeof candidate.index === "number" ? candidate.index : position
      const nextCandidate = nextCandidates.find((value, nextPosition) => (typeof value.index === "number" ? value.index : nextPosition) === index)
      normalizeElementSignatures(candidate)
      if (nextCandidate) normalizeElementSignatures(nextCandidate)
      relocateSignatureOnlyForward(candidate, nextCandidate, removed)
      relocateSignatureOnlyBackward(candidate, nextCandidate, removed)
      const parts = candidate.content.parts
      const firstIndexes = firstElementIndexes(parts)
      const firstHasNatural = firstIndexes.some(index => typeof parts[index]?.thoughtSignature === "string")
      const signatureOnlyNatural = firstIndexes.length === 0 && parts.some(part => typeof part.thoughtSignature === "string")
      const firstContentIndex = firstIndexes.find(index => hasPartContent(partAt(parts, index)))
      const lastFirstContentIndex = firstIndexes.findLast(index => hasPartContent(partAt(parts, index)))
      const firstContent = lastFirstContentIndex === undefined ? undefined : parts[lastFirstContentIndex]
      const nextContent = nextCandidate ? firstContentPart(nextCandidate.content.parts) : undefined
      const continues = firstContent !== undefined && nextContent !== undefined && sameLogicalElement(firstContent, nextContent)
      const closed = (lastFirstContentIndex !== undefined && parts.slice(lastFirstContentIndex + 1).some(hasPartContent))
        || candidate.finishReason !== undefined
        || (next !== undefined && nextCandidate === undefined)
        || (nextCandidate !== undefined && nextContent === undefined && !removed.has(nextCandidate))
        || (nextContent !== undefined && !continues)
        || terminal
      for (let index = 0; index < parts.length; index++) {
        if (typeof parts[index]?.thoughtSignature === "string") parts[index] = await this.natural(partAt(parts, index))
      }
      if (this.anchored.has(index)) continue
      if (firstHasNatural || signatureOnlyNatural) this.anchored.add(index)
      else if (firstContentIndex !== undefined && closed) {
        parts[firstContentIndex] = await this.origin(partAt(parts, firstContentIndex))
        this.anchored.add(index)
      }
      if (this.anchored.size > 1024) throw new InvalidAffinityStateError()
    }
    if (Array.isArray(current.candidates)) current.candidates = current.candidates.filter(value => !object(value) || !removed.has(value as Candidate))
    if (next && Array.isArray(next.candidates)) next.candidates = next.candidates.filter(value => !object(value) || !removed.has(value as Candidate))
    const currentEmptied = currentCandidates.length > 0 && Array.isArray(current.candidates) && current.candidates.length === 0
    const nextEmptied = nextCandidates.length > 0 && next && Array.isArray(next.candidates) && next.candidates.length === 0
    if (currentEmptied && next && !nextEmptied) {
      mergeEventMetadata(current, next, next)
      clearEventMetadata(current)
      this.suppressed.add(current)
    } else if (nextEmptied && next && !currentEmptied) {
      mergeEventMetadata(current, next, current)
      clearEventMetadata(next)
      this.suppressed.add(next)
    }
    return current
  }
}

// Real content-bearing Parts keep their own natural state. Only independent
// signature-only trailers may move onto an adjacent compatible content Part.
const normalizeElementSignatures = (candidate: Candidate): void => {
  const parts = candidate.content.parts
  const relocated = new Set<Part>()
  for (const indexes of logicalElementGroups(parts)) {
    for (const index of indexes) {
      const source = partAt(parts, index)
      if (!relocatableSignature(source)) continue
      const previous = indexes.filter(value => value < index && hasPartContent(partAt(parts, value))).at(-1)
      const targetIndex = previous ?? indexes.find(value => value > index && hasPartContent(partAt(parts, value)))
      const target = targetIndex === undefined ? undefined : parts[targetIndex]
      if (!target || target.thoughtSignature !== undefined) continue
      target.thoughtSignature = source.thoughtSignature
      delete source.thoughtSignature
      relocated.add(source)
    }
  }
  removeRelocatedSignatureParts(candidate, relocated)
}

const relocateSignatureOnlyForward = (
  current: Candidate,
  next: Candidate | undefined,
  removedCandidates: WeakSet<Candidate>,
): void => {
  if (
    next === undefined
    || current.finishReason !== undefined
    || current.content.parts.some(hasPartContent)
  ) return
  const relocated = new Set(current.content.parts.filter(relocatableSignature))
  if (relocated.size !== 1) return
  const signature = relocated.values().next().value?.thoughtSignature
  const targetIndex = firstElementIndexes(next.content.parts).find(index => hasPartContent(partAt(next.content.parts, index)))
  if (signature === undefined || targetIndex === undefined) return
  if (partAt(next.content.parts, targetIndex).thoughtSignature !== undefined) return
  partAt(next.content.parts, targetIndex).thoughtSignature = signature
  for (const part of relocated) delete part.thoughtSignature
  removeRelocatedSignatureParts(current, relocated, removedCandidates)
  if (current.content.parts.length === 0) transferCandidateMetadataForward(current, next)
}

const relocateSignatureOnlyBackward = (
  current: Candidate,
  next: Candidate | undefined,
  removedCandidates: WeakSet<Candidate>,
): void => {
  if (
    next === undefined
    || current.finishReason !== undefined
    || next.content.parts.some(hasPartContent)
  ) return
  const targetIndex = firstContentIndexOfLastElement(current.content.parts)
  if (targetIndex === undefined || partAt(current.content.parts, targetIndex).thoughtSignature !== undefined) return
  const signatureOnly = next.content.parts.find(relocatableSignature)
  if (signatureOnly?.thoughtSignature === undefined) return

  current.content.parts[targetIndex] = {
    ...current.content.parts[targetIndex],
    thoughtSignature: signatureOnly.thoughtSignature,
  }
  delete signatureOnly.thoughtSignature
  removeRelocatedSignatureParts(next, new Set([signatureOnly]), removedCandidates)
  if (next.content.parts.length === 0) {
    transferCandidateMetadata(current, next)
    delete next.finishReason
  }
}

const removeRelocatedSignatureParts = (
  candidate: Candidate,
  relocated: ReadonlySet<Part>,
  removedCandidates?: WeakSet<Candidate>,
): void => {
  candidate.content.parts = candidate.content.parts.filter(part =>
    !relocated.has(part) || hasPartContent(part) || part.thoughtSignature !== undefined)
  if (candidate.content.parts.length === 0) removedCandidates?.add(candidate)
}

const hasPartContent = (part: Part): boolean =>
  (typeof part.text === "string" && part.text.length > 0)
  || ["inlineData", "fileData", "functionCall", "functionResponse", "executableCode", "codeExecutionResult"].some(key => object(part[key]))

const relocatableSignature = (part: Part): boolean => typeof part.thoughtSignature === "string" && !hasPartContent(part)
  && Object.keys(part).every(key => ["thoughtSignature", "thought", "text"].includes(key))

const sameLogicalElement = (left: Part, right: Part): boolean => {
  if (left.text !== undefined || right.text !== undefined) {
    return left.text !== undefined && right.text !== undefined && (left.thought === true) === (right.thought === true)
  }
  if (left.functionCall !== undefined || right.functionCall !== undefined) {
    if (left.functionCall === undefined || right.functionCall === undefined) return false
    if (object(left.functionCall) && object(right.functionCall) && left.functionCall.id !== undefined && right.functionCall.id !== undefined) {
      return left.functionCall.id === right.functionCall.id
    }
    // Name/shape cannot distinguish a continuation from two adjacent complete
    // id-less calls, so ambiguous or asymmetric-ID calls remain separate.
    return false
  }
  return false
}

const logicalElementGroups = (parts: readonly Part[]): number[][] => {
  const groups: number[][] = []
  let indexes: number[] = []
  let previousContent: Part | undefined
  const flush = () => {
    if (indexes.length > 0) groups.push(indexes)
    indexes = []
    previousContent = undefined
  }
  for (let index = 0; index < parts.length; index += 1) {
    const part = partAt(parts, index)
    if (!hasPartContent(part)) {
      if (part.thoughtSignature !== undefined) indexes.push(index)
      continue
    }
    if (previousContent !== undefined && !sameLogicalElement(previousContent, part)) flush()
    indexes.push(index)
    previousContent = part
  }
  flush()
  return groups
}

const firstElementIndexes = (parts: readonly Part[]): number[] =>
  logicalElementGroups(parts).find(indexes => indexes.some(index => hasPartContent(partAt(parts, index)))) ?? []

const firstContentIndexOfLastElement = (parts: readonly Part[]): number | undefined =>
  logicalElementGroups(parts)
    .findLast(indexes => indexes.some(index => hasPartContent(partAt(parts, index))))
    ?.find(index => hasPartContent(partAt(parts, index)))

const firstContentPart = (parts: readonly Part[]): Part | undefined =>
  parts.find(hasPartContent)

const mergeEventMetadata = (earlier: JsonObject, later: JsonObject, target: JsonObject): void => {
  const metadata = { ...earlier, ...later }
  delete metadata.candidates
  for (const key of Object.keys(target)) if (key !== "candidates") delete target[key]
  Object.assign(target, metadata)
}
const clearEventMetadata = (event: JsonObject): void => {
  for (const key of Object.keys(event)) if (key !== "candidates") delete event[key]
}
const transferCandidateMetadata = (current: Candidate, next: Candidate): void => {
  const metadata: JsonObject = { ...current, ...next }
  delete metadata.content
  Object.assign(current, metadata)
  current.content = { ...current.content, ...next.content, parts: current.content.parts }
}
const transferCandidateMetadataForward = (current: Candidate, next: Candidate): void => {
  const metadata: JsonObject = { ...current, ...next }
  delete metadata.content
  Object.assign(next, metadata)
  next.content = { ...current.content, ...next.content, parts: next.content.parts }
}
