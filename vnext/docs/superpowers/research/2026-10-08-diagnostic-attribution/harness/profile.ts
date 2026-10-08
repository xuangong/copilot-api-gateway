import { readFileSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { TraceMap, originalPositionFor, decodedMappings } from "../../../../../node_modules/.bun/@jridgewell+trace-mapping@0.3.31/node_modules/@jridgewell/trace-mapping"
import { sha, type FileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"

type Obj = Record<string, unknown>
function object(value: unknown): Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid profile object")
  return value as Obj
}
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
export interface Frame { functionName: string; url: string; lineNumber: number; columnNumber: number }
export interface ProfileNode { id: number; callFrame: Frame; children: number[] }
export interface ValidProfile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }

/** Reject incomplete populations rather than interpreting missing samples as zero CPU. */
export function validateProfile(input: unknown): ValidProfile {
  const value = object(input)
  if (!finite(value.startTime) || !finite(value.endTime) || value.startTime < 0 || value.endTime < value.startTime) throw new Error("Invalid profile time range")
  if (!Array.isArray(value.nodes) || !value.nodes.length || !Array.isArray(value.samples) || !Array.isArray(value.timeDeltas) || value.samples.length !== value.timeDeltas.length) throw new Error("Invalid profile sample population")
  const nodes: ProfileNode[] = value.nodes.map((raw: unknown) => {
    const node = object(raw), callFrame = object(node.callFrame)
    if (!integer(node.id) || node.id <= 0 || typeof callFrame.functionName !== "string" || typeof callFrame.url !== "string" || !integer(callFrame.lineNumber) || callFrame.lineNumber < -1 || !integer(callFrame.columnNumber) || callFrame.columnNumber < -1) throw new Error("Invalid profile node/frame")
    const children: unknown = node.children ?? []
    if (!Array.isArray(children) || !children.every((id: unknown) => integer(id) && id > 0) || new Set(children).size !== children.length) throw new Error("Invalid profile children")
    return { id: node.id, callFrame: { functionName: callFrame.functionName, url: callFrame.url, lineNumber: callFrame.lineNumber, columnNumber: callFrame.columnNumber }, children: children as number[] }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  if (byId.size !== nodes.length) throw new Error("Duplicate profile node")
  const parents = new Map<number, number>()
  for (const node of nodes) for (const child of node.children) {
    if (!byId.has(child) || child === node.id || parents.has(child)) throw new Error("Invalid profile child identity or multiple parents")
    parents.set(child, node.id)
  }
  const roots = nodes.filter(node => !parents.has(node.id))
  if (roots.length !== 1) throw new Error("Profile requires a single root")
  const visited = new Set<number>(), pending = roots.map(node => node.id)
  while (pending.length) {
    const id = pending.pop()
    if (id === undefined || visited.has(id)) throw new Error("Profile tree cycle")
    const node = byId.get(id)
    if (!node) throw new Error("Unknown profile tree node")
    visited.add(id); pending.push(...node.children)
  }
  if (visited.size !== nodes.length) throw new Error("Unreachable profile tree nodes")
  const samples: number[] = value.samples.map((id: unknown) => {
    if (!integer(id) || !byId.has(id)) throw new Error("Unknown profile sample node")
    return id
  })
  const timeDeltas: number[] = value.timeDeltas.map((delta: unknown) => {
    if (!finite(delta) || delta < 0) throw new Error("Invalid profile delta")
    return delta
  })
  const sum = timeDeltas.reduce((a, b) => a + b, 0)
  if (!Number.isFinite(sum) || sum > value.endTime - value.startTime + 1) throw new Error("Profile sample time exceeds window")
  return { nodes, samples, timeDeltas, startTime: value.startTime, endTime: value.endTime }
}

export type Kind = "idle" | "gc" | "runtime" | "harness" | "dependency" | "product" | "unmapped"
export interface MappedFrame { kind: "harness" | "dependency" | "product"; source: string; line: number; column: number }
export type FrameMapper = (frame: Frame) => MappedFrame | null
export function summarizeProfile(profile: ValidProfile, mapper: FrameMapper) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const buckets = new Map<string, { kind: Kind; source: string | null; line: number | null; column: number | null; functionName: string; generatedUrl: string; generatedLine: number; generatedColumn: number; sampleCount: number; sampleWeightUs: number }>()
  const mapped = new Map<number, MappedFrame | null>()
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i], delta = profile.timeDeltas[i]
    const node = id === undefined ? undefined : nodes.get(id)
    if (!node || delta === undefined) throw new Error("Profile population changed after validation")
    const frame = node.callFrame
    let kind: Kind, location: MappedFrame | null = null
    if (frame.functionName === "(idle)") kind = "idle"
    else if (frame.functionName === "(garbage collector)") kind = "gc"
    else if (!frame.url || frame.lineNumber < 0 || frame.columnNumber < 0 || ["(root)", "(program)"].includes(frame.functionName) || /^(node:|cloudflare:|workerd:)/.test(frame.url)) kind = "runtime"
    else {
      if (!mapped.has(node.id)) mapped.set(node.id, mapper(frame))
      location = mapped.get(node.id) ?? null
      kind = location?.kind ?? "unmapped"
    }
    const key = JSON.stringify([kind, location?.source, location?.line, location?.column, frame.functionName, frame.url, frame.lineNumber, frame.columnNumber])
    const bucket = buckets.get(key) ?? { kind, source: location?.source ?? null, line: location?.line ?? null, column: location?.column ?? null, functionName: frame.functionName, generatedUrl: frame.url, generatedLine: frame.lineNumber, generatedColumn: frame.columnNumber, sampleCount: 0, sampleWeightUs: 0 }
    bucket.sampleCount++; bucket.sampleWeightUs += delta; buckets.set(key, bucket)
  }
  const coveredUs = profile.timeDeltas.reduce((a, b) => a + b, 0), wallWindowUs = profile.endTime - profile.startTime
  return { sampleCount: profile.samples.length, hasSamples: profile.samples.length > 0, firstDeltaUs: profile.timeDeltas[0] ?? null, coveredUs, wallWindowUs, lastSampleTime: profile.startTime + coveredUs, tailUs: wallWindowUs - coveredUs, buckets: [...buckets.values()].sort((a, b) => b.sampleWeightUs - a.sampleWeightUs), boundary: "Exclusive leaf sample counts and preceding sample-interval weights, including the first start-to-sample delta. Not CPU time; no tail redistribution, ancestor reassignment or process-CPU scaling. Empty/sparse profiles cannot establish zero cost or precise attribution." }
}

interface FlatMap { version: 3; sources: string[]; sourcesContent: (string | null)[]; mappings: string; names: string[]; sourceRoot?: string }
function checkedBytes(identity: FileIdentity) {
  const bytes = readFileSync(identity.path)
  if (bytes.byteLength !== identity.bytes || sha(bytes) !== identity.sha256) throw new Error(`Source map/input identity mismatch: ${identity.path}`)
  return bytes
}
function canonical(path: string) { return realpathSync(path) }
function mappedPath(path: string, mapPath: string) { return canonical(path.startsWith("file:") ? fileURLToPath(path) : resolve(dirname(mapPath), path)) }
const textLines = (text: string) => text.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line)
function inRange(lines: readonly string[], line: number, column: number) {
  const value = lines[line]
  return Number.isSafeInteger(line) && Number.isSafeInteger(column) && column >= 0 && value !== undefined && column <= value.length
}
export type GeneratedConvention = "physical" | "bun-1.3.0-crlf-double"
function generatedCoordinates(text: string, convention: GeneratedConvention) {
  const physical = textLines(text)
  if (convention === "physical") return { lines: physical, lookupLine: (line: number) => line }
  if (/\r(?!\n)/.test(text)) throw new Error("Frozen Bun mapping convention rejects bare CR")
  let extra = 0
  const lookup = text.split("\n").map((line, index) => { const mapped = index + extra; if (line.endsWith("\r")) extra++; return mapped })
  return { lines: text.replaceAll("\r", "\n").split("\n"), lookupLine: (line: number) => lookup[line] ?? -1 }
}
function readMap(identity: FileIdentity, generated: string, approved: Map<string, FileIdentity>, convention: GeneratedConvention) {
  const data = object(JSON.parse(checkedBytes(identity).toString("utf8")))
  if (data.version !== 3 || data.sections !== undefined || !Array.isArray(data.sources) || !data.sources.every((x: unknown) => typeof x === "string") || !Array.isArray(data.sourcesContent) || data.sourcesContent.length !== data.sources.length || !data.sourcesContent.every((x: unknown) => x === null || typeof x === "string") || !Array.isArray(data.names) || !data.names.every((x: unknown) => typeof x === "string") || typeof data.mappings !== "string" || data.sourceRoot !== undefined && typeof data.sourceRoot !== "string") throw new Error("Unsupported source map schema")
  const flat = data as unknown as FlatMap
  const trace = new TraceMap(flat, pathToFileURL(identity.path).href)
  const coordinates = generatedCoordinates(generated, convention)
  const generatedLines = coordinates.lines
  const originalLines = flat.sourcesContent.map(content => content === null ? null : textLines(content))
  for (const [lineNumber, line] of decodedMappings(trace).entries()) for (const segment of line) {
    if (![1, 4, 5].includes(segment.length) || segment.some(value => !integer(value) || value < 0) || segment.length >= 4 && (segment[1] === undefined || segment[1] >= flat.sources.length) || segment.length === 5 && (segment[4] === undefined || segment[4] >= flat.names.length)) throw new Error("Invalid source map segment")
    if (segment[0] === undefined || !inRange(generatedLines, lineNumber, segment[0])) throw new Error("Generated source map coordinate out of range")
    if (segment.length >= 4) {
      const sourceIndex = segment[1], sourceLine = segment[2], sourceColumn = segment[3]
      if (sourceIndex === undefined || sourceLine === undefined || sourceColumn === undefined) throw new Error("Invalid source map location")
      const lines = originalLines[sourceIndex]
      if (lines && !inRange(lines, sourceLine, sourceColumn)) throw new Error("Original source map coordinate out of range")
    }
  }
  const proven = new Set<string>(), seen = new Set<string>()
  for (let i = 0; i < trace.resolvedSources.length; i++) {
    const source = trace.resolvedSources[i], content = flat.sourcesContent[i]
    if (typeof source !== "string") continue
    let path: string
    try { path = mappedPath(source, identity.path) } catch { continue }
    if (seen.has(path)) throw new Error(`Duplicate canonical source map source: ${path}`)
    seen.add(path)
    if (typeof content !== "string") continue
    const expected = approved.get(path)
    if (!expected) continue
    checkedBytes(expected)
    if (Buffer.byteLength(content) !== expected.bytes || sha(content) !== expected.sha256) throw new Error(`Source map content differs from frozen input: ${path}`)
    proven.add(path)
  }
  return { trace, proven, lookupLine: coordinates.lookupLine }
}

export function createProfileMapper(options: { entry: FileIdentity; entryMap: FileIdentity; bundle: FileIdentity; bundleMap: FileIdentity; approved: readonly FileIdentity[]; harness: readonly FileIdentity[]; generatedConvention?: GeneratedConvention }): FrameMapper {
  const entryText = checkedBytes(options.entry).toString("utf8"), bundleText = checkedBytes(options.bundle).toString("utf8")
  const entryLines = textLines(entryText)
  const entry = canonical(options.entry.path), bundle = canonical(options.bundle.path)
  const harness = new Map(options.harness.map(file => [canonical(file.path), file]))
  const approved = new Map(options.approved.map(file => [canonical(file.path), file]))
  const convention = options.generatedConvention ?? "physical"
  const outer = readMap(options.entryMap, entryText, new Map([[bundle, options.bundle], ...harness]), convention)
  const inner = readMap(options.bundleMap, bundleText, approved, convention)
  if (!outer.proven.has(bundle)) throw new Error("Entry source map has no proven frozen bundle content")
  const mapAt = (map: ReturnType<typeof readMap>, mapIdentity: FileIdentity, line: number, column: number) => {
    const lookupLine = map.lookupLine(line - 1) + 1
    if (lookupLine <= 0) return null
    const position = originalPositionFor(map.trace, { line: lookupLine, column })
    if (position.source === null || position.line === null || position.column === null) return null
    let source: string
    try { source = mappedPath(position.source, mapIdentity.path) } catch { return null }
    if (!map.proven.has(source)) return null
    return { source, line: position.line, column: position.column }
  }
  return frame => {
    if (!frame.url || frame.lineNumber < 0 || frame.columnNumber < 0) return null
    let path: string
    try { path = canonical(frame.url.startsWith("file:") ? fileURLToPath(frame.url) : frame.url) } catch { return null }
    if (path !== entry || !inRange(entryLines, frame.lineNumber, frame.columnNumber)) return null
    const first = mapAt(outer, options.entryMap, frame.lineNumber + 1, frame.columnNumber)
    if (!first) return null
    if (harness.has(first.source)) return { kind: "harness", ...first }
    if (first.source !== bundle) return null
    const second = mapAt(inner, options.bundleMap, first.line, first.column)
    return second ? { kind: second.source.includes("/node_modules/") ? "dependency" : "product", ...second } : null
  }
}
