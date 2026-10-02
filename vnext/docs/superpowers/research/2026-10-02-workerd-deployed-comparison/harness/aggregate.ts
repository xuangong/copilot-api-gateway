import { readFileSync } from "node:fs"
import { join } from "node:path"
import { collectionEvidence, readJournal, type Event } from "./journal.ts"
import { EXPECTED, PROTOCOLS, SCENARIOS, UNITS, type Unit, type Variant } from "./types.ts"
import { sha, type Manifest, verifyManifest } from "./manifest.ts"
import type { Receipt } from "./unit.ts"
import type { Supervision } from "./supervisor.ts"
import { matrixOutcomes } from "./matrix.ts"
import { verifyWireEvidence } from "./readback.ts"

export const signature = (row: Event) => JSON.stringify([row.protocol, row.upstream, row.scenario, row.stream])
export function validateShape(rows: Event[], unit: Unit | "canary") {
  const terminals = rows.filter(row => row.event === "terminal")
  const errors: string[] = []
  const variants: Variant[] = unit === "latency-pair" || unit === "canary" ? ["A", "B"] : [unit.startsWith("A-") ? "A" : "B"]
  for (const variant of variants) {
    const own = terminals.filter(row => row.variant === variant)
    const phase = unit === "latency-pair" ? "latency" : unit === "canary" ? "canary" : unit.endsWith("matrix") ? "matrix" : "diagnostic"
    for (const stream of [false, true]) {
      const warm = own.filter(row => row.phase === `${phase}_warmup` && row.stream === stream)
      if (warm.length !== (unit === "canary" ? 0 : 12)) errors.push(`${variant}/${phase}/warmup/${stream}`)
      const timed = own.filter(row => row.phase === phase && row.stream === stream)
      if (phase !== "matrix" && timed.length !== (unit === "canary" ? 1 : 40)) errors.push(`${variant}/${phase}/count/${stream}`)
      if (phase === "latency") for (let block = 0; block < 4; block++) if (timed.filter(row => row.block === block).length !== 10) errors.push(`${variant}/block/${block}/${stream}`)
      if (phase === "matrix") {
        const actual = new Set(timed.map(signature))
        const wanted = PROTOCOLS.flatMap(protocol => PROTOCOLS.flatMap(upstream => SCENARIOS.map(scenario => JSON.stringify([protocol, upstream, scenario, stream]))))
        if (timed.length !== 63 || actual.size !== 63 || !wanted.every(key => actual.has(key))) errors.push(`${variant}/matrix/cells/${stream}`)
      }
    }
    if (own.some(row => ![phase, `${phase}_warmup`].includes(String(row.phase)))) errors.push(`${variant}/unexpected phase`)
    const ordinary = own.filter(row => row.phase !== "matrix")
    if (ordinary.some(row => row.protocol !== "responses" || row.upstream !== "responses" || row.scenario !== "ok" || row.bytes !== 65536)) errors.push(`${variant}/ordinary fixture`)
  }
  if (terminals.some(row => !variants.includes(row.variant as Variant))) errors.push("Unexpected variant")
  return errors
}
export interface UnitEvidence { receipt: Receipt; rows: Event[]; supervision: Supervision }
export function qualifyUnits(units: UnitEvidence[], manifestId: string, manifestSha256: string, canary = false) {
  const declared: (Unit | "canary")[] = canary ? ["canary"] : [...UNITS]
  const errors: string[] = []
  if (units.length !== declared.length) errors.push("Missing or extra child receipt")
  const allRows: Event[] = []
  for (const [index, evidence] of units.entries()) {
    const { receipt, rows, supervision } = evidence
    const unit = declared[index]
    if (!unit || receipt.unit !== unit || receipt.manifestSha256 !== manifestSha256 || receipt.experimentId !== manifestId || receipt.version !== 1) errors.push("Child order/unit/identity mismatch")
    const expected = unit === "canary" ? 4 : unit ? EXPECTED[unit] : -1
    const collected = collectionEvidence(rows, expected, receipt.flags)
    if (!receipt.completed || receipt.fatal || receipt.expected !== expected || !collected.completed) errors.push(`Incomplete child ${receipt.unit}`)
    if (JSON.stringify(collected) !== JSON.stringify(receipt.evidence)) errors.push(`Receipt/journal disagreement ${receipt.unit}`)
    if (supervision.exitCode !== 0 || supervision.timedOut || supervision.interrupted || !supervision.cleanupComplete) errors.push(`Physical child cleanup/exit failed ${receipt.unit}`)
    if (unit) errors.push(...validateShape(rows, unit))
    allRows.push(...rows)
  }
  const offered = allRows.filter(row => row.event === "offered")
  const terminal = allRows.filter(row => row.event === "terminal")
  if (new Set(offered.map(row => row.id)).size !== offered.length || new Set(terminal.map(row => row.id)).size !== terminal.length) errors.push("Global request ID collision")
  const expected = canary ? 4 : 716
  if (offered.length !== expected || terminal.length !== expected) errors.push("Strict total offer/terminal count failed")
  const matrices = terminal.filter(row => row.phase === "matrix")
  const a = matrices.filter(row => row.variant === "A")
  const b = matrices.filter(row => row.variant === "B")
  const regressions = b.filter(row => row.ok !== true && a.some(before => before.ok === true && signature(before) === signature(row)))
  const candidateFailures = b.filter(row => row.ok !== true)
  const observed = matrixOutcomes(allRows, canary)
  errors.push(...observed.errors)
  const collectionCompleted = errors.length === 0
  const noRegression = observed.matrix.wire.noRegression && observed.matrix.captureFidelity.noRegression
  if (regressions.length) errors.push("B semantic regression")
  if (observed.matrix.captureFidelity.regressions.length) errors.push("B capture fidelity regression")
  return { completed: collectionCompleted && noRegression, collectionCompleted, noRegression, errors, expected, offered: offered.length, terminal: terminal.length, regressions, candidateFailures, baselineFailures: a.filter(row => row.ok !== true), matrix: observed.matrix }
}
export function readEvidence(directory: string): UnitEvidence {
  const receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8")) as Receipt
  const supervision = JSON.parse(readFileSync(join(directory, "supervision.json"), "utf8")) as Supervision
  const rows = readJournal(join(directory, "journal.jsonl"))
  // Require durable final storage/dispatch evidence, beyond claimed receipt flags.
  const variants: Variant[] = receipt.unit === "latency-pair" || receipt.unit === "canary" ? ["A", "B"] : [receipt.unit.startsWith("A-") ? "A" : "B"]
  for (const variant of variants) {
    const logical = rows.filter(row => row.event === "terminal" && row.variant === variant)
    const dispatch = rows.filter(row => row.event === "dispatch_readback" && row.variant === variant)
    if (dispatch.length !== 1 || dispatch[0]?.exactlyOnce !== true || dispatch[0]?.complete !== true || dispatch[0]?.requests !== logical.length) throw new Error(`Missing durable dispatch evidence ${variant}`)
    const settlements = rows.filter(row => row.event === "settlement" && row.variant === variant)
    const final = settlements.at(-1)
    const dumps = final?.dumps as { checkedRecords?: number; sqlRows?: number; ownedObjects?: number } | undefined
    const background = final?.background as { pending?: number; registered?: number; settled?: number; failures?: unknown[] } | undefined
    if (!dumps || dumps.checkedRecords !== logical.length || dumps.sqlRows !== logical.length || dumps.ownedObjects !== logical.length * (variant === "A" ? 2 : 3)
      || !background || background.pending !== 0 || background.registered !== background.settled || background.failures?.length !== 0) throw new Error(`Missing durable storage/settlement evidence ${variant}`)
    const captured = rows.filter(row => row.event === "dump_readback" && row.variant === variant).flatMap(row => Array.isArray(row.records) ? row.records as { logicalId: string }[] : [])
    if (captured.length !== logical.length || new Set(captured.map(row => row.logicalId)).size !== logical.length || !logical.every(row => captured.some(record => record.logicalId === row.id))) throw new Error(`Incomplete durable physical reads ${variant}`)
    for (const row of logical) {
      verifyWireEvidence(row as unknown as import("./readback.ts").LogicalDump)
    }
  }
  return { receipt, supervision, rows }
}
const quantile = (values: number[], q: number) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * q) - 1] ?? null
export function measurements(rows: Event[]) {
  return (["A", "B"] as const).flatMap(variant => [false, true].map(stream => {
    const own = rows.filter(row => row.event === "terminal" && row.variant === variant && row.phase === "latency" && row.stream === stream && row.ok === true)
    const values = (part: Event[], field: string) => part.flatMap(row => typeof row[field] === "number" ? [row[field] as number] : [])
    return { variant, mode: stream ? "sse" : "json", requests: own.length, p50EofMs: quantile(values(own, "eofMs"), .5), p95EofMs: quantile(values(own, "eofMs"), .95), p50FirstSemanticMs: quantile(values(own, "firstSemanticMs"), .5), p95FirstSemanticMs: quantile(values(own, "firstSemanticMs"), .95), blocks: [0,1,2,3].map(block => ({ block, p50EofMs: quantile(values(own.filter(row => row.block === block), "eofMs"), .5), p50FirstSemanticMs: quantile(values(own.filter(row => row.block === block), "firstSemanticMs"), .5) })) }
  }))
}
export function aggregate(manifest: Manifest, manifestSha256: string, output: string, canary = false) {
  verifyManifest(manifest)
  const units = (canary ? ["canary"] : UNITS).map(unit => readEvidence(join(output, unit)))
  const qualification = qualifyUnits(units, manifest.id, manifestSha256, canary)
  const rows = units.flatMap(unit => unit.rows)
  const physicalObjects = rows.filter(row => row.event === "dump_readback").flatMap(row => Array.isArray(row.records) ? row.records as { objects: { side: string; compressedBytes: number; decodedBytes: number }[] }[] : []).flatMap(record => record.objects)
  const storage = ["request", "response", "upstream"].map(side => ({ side, objects: physicalObjects.filter(object => object.side === side).length, compressedBytes: physicalObjects.filter(object => object.side === side).reduce((sum, object) => sum + object.compressedBytes, 0), decodedBytes: physicalObjects.filter(object => object.side === side).reduce((sum, object) => sum + object.decodedBytes, 0) }))
  if (physicalObjects.length !== (canary ? 10 : 1790)) { qualification.completed = false; qualification.collectionCompleted = false; qualification.errors.push("Physical object total mismatch") }
  return { version: 1, manifestSha256, experimentId: manifest.id, kind: canary ? "canary" : "formal", ...qualification, latency: measurements(rows), diagnostic: rows.filter(row => row.event === "diagnostic"), storage,
    boundary: "Local synthetic direct_fetch only. V8 sampled non-idle time is not billed/process CPU; settled heap is not peak/RSS/leak proof or the cloud limit. No production parity or saturation coverage is inferred." }
}
