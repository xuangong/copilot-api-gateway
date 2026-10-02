import { test, expect } from "bun:test"
import { qualifyUnits, validateShape, type UnitEvidence } from "./aggregate.ts"
import { collectionEvidence, type Event } from "./journal.ts"
import { EXPECTED, PROTOCOLS, SCENARIOS, UNITS, type Unit } from "./types.ts"

function evidence(unit: Unit): UnitEvidence {
  const rows: Event[] = []
  const phase = unit === "latency-pair" ? "latency" : unit.endsWith("matrix") ? "matrix" : "diagnostic"
  const variants = unit === "latency-pair" ? ["A", "B"] : [unit.slice(0, 1)]
  const add = (variant: string, stream: boolean, phase: string, block = -1, protocol = "responses", upstream = "responses", scenario = "ok") => {
    const id = `${unit}_${rows.length}`
    rows.push({ event: "offered", id, variant, phase, stream, protocol, upstream, scenario, bytes: 65536 })
    rows.push({ event: "terminal", id, variant, phase, stream, protocol, upstream, scenario, bytes: 65536, block, transportCompleted: true, ok: true })
  }
  for (const variant of variants) for (const stream of [false, true]) {
    for (let i = 0; i < 12; i++) add(variant, stream, `${phase}_warmup`)
    if (phase === "matrix") for (const protocol of PROTOCOLS) for (const upstream of PROTOCOLS) for (const scenario of SCENARIOS) add(variant, stream, phase, -1, protocol, upstream, scenario)
    else for (let i = 0; i < 40; i++) add(variant, stream, phase, Math.floor(i / 10))
  }
  const flags = { dispatchExactlyOnce: true, storageReadback: true, backgroundSettled: true, cleanupComplete: true, identitiesMatch: true }
  return { rows, receipt: { version: 1, manifestSha256: "sha", experimentId: "experiment", unit, expected: EXPECTED[unit], completed: true, fatal: null, flags, evidence: collectionEvidence(rows, EXPECTED[unit], flags) }, supervision: { pid: 1, exitCode: 0, signal: null, timedOut: false, interrupted: false, cleanupComplete: true, actions: [] } }
}
test("aggregate requires exactly five receipts, immutable identity and physical cleanup", () => {
  const units = UNITS.map(evidence)
  expect(qualifyUnits(units, "experiment", "sha").completed).toBe(true)
  expect(qualifyUnits(units.slice(0, 4), "experiment", "sha").completed).toBe(false)
  expect(qualifyUnits(units, "experiment", "different").completed).toBe(false)
  const first = units[0]
  if (!first) throw new Error("Fixture missing unit")
  first.supervision.cleanupComplete = false
  expect(qualifyUnits(units, "experiment", "sha").completed).toBe(false)
})
test("aggregate rejects count-preserving duplicate matrix cells and global request ID collisions", () => {
  const units = UNITS.map(evidence)
  const matrix = units[1]
  if (!matrix) throw new Error("Fixture missing matrix")
  const cells = matrix.rows.filter(row => row.event === "terminal" && row.phase === "matrix")
  const first = cells[0], second = cells[1]
  if (!first || !second) throw new Error("Fixture missing matrix cells")
  second.scenario = first.scenario
  expect(validateShape(matrix.rows, "A-matrix").length).toBeGreaterThan(0)
  const fresh = UNITS.map(evidence)
  const a = fresh[1], b = fresh[2]
  if (!a || !b) throw new Error("Fixture missing matrices")
  const aid = a.rows[0]?.id, bid = b.rows[0]?.id
  for (const row of b.rows) if (row.id === bid) row.id = aid
  b.receipt.evidence = collectionEvidence(b.rows, 150, b.receipt.flags)
  expect(qualifyUnits(fresh, "experiment", "sha").errors).toContain("Global request ID collision")
})
test("baseline matrix defects remain explicit but B declared failures cannot qualify", () => {
  const units = UNITS.map(evidence)
  const a = units[1], b = units[2]
  if (!a || !b) throw new Error("Fixture missing matrices")
  const ar = a.rows.find(row => row.event === "terminal" && row.phase === "matrix")
  const br = b.rows.find(row => row.event === "terminal" && row.phase === "matrix")
  if (!ar || !br) throw new Error("Fixture missing cell")
  ar.ok = false
  expect(qualifyUnits(units, "experiment", "sha").completed).toBe(true)
  br.ok = false
  expect(qualifyUnits(units, "experiment", "sha").completed).toBe(false)
})
