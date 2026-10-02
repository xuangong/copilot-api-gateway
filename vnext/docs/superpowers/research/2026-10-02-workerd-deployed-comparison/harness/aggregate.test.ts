import { test, expect } from "bun:test"
import { qualifyUnits, validateShape, type UnitEvidence } from "./aggregate.ts"
import { collectionEvidence, type Event } from "./journal.ts"
import { EXPECTED, PROTOCOLS, SCENARIOS, UNITS, type Unit } from "./types.ts"
import { sha } from "./manifest.ts"

function evidence(unit: Unit): UnitEvidence {
  const rows: Event[] = []
  const phase = unit === "latency-pair" ? "latency" : unit.endsWith("matrix") ? "matrix" : "diagnostic"
  const variants = unit === "latency-pair" ? ["A", "B"] : [unit.slice(0, 1)]
  const add = (variant: string, stream: boolean, phase: string, block = -1, protocol = "responses", upstream = "responses", scenario = "ok") => {
    const id = `${unit}_${rows.length}`
    const digest = sha("fixture")
    const responseKey = `dumps/v1/architecture-key/${id}/response`
    rows.push({ event: "offered", id, variant, phase, stream, protocol, upstream, scenario, bytes: 65536 })
    rows.push({ event: "terminal", id, dumpRecordId: `dump_${id}`, status: 200, variant, phase, stream, protocol, upstream, scenario, bytes: 65536, block, transportCompleted: true, ok: true, errors: [], classification: "success", wireEvidence: `/fixture/${id}-wire.json`, requestSha256: digest, responseSha256: digest })
    rows.push({ event: "dump_readback", variant, records: [{ logicalId: id, recordId: `dump_${id}`, status: 200, objects: [{ side: "response", key: responseKey, type: "events", sha256: digest }], captureFidelity: { comparator: "response-frame-fidelity-v1", passed: true, classification: "exact_wire_frames", errors: [], storedSha256: digest, wireSha256: digest, evidence: { wireEvidence: `/fixture/${id}-wire.json`, responseKey, responseType: "events" }, details: {} } }] })
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
test("wire outcomes retain full comparisons, improvements and unresolved failure details while regressions cannot qualify", () => {
  const units = UNITS.map(evidence)
  const a = units[1], b = units[2]
  if (!a || !b) throw new Error("Fixture missing matrices")
  const ar = a.rows.find(row => row.event === "terminal" && row.phase === "matrix")
  const br = b.rows.find(row => row.event === "terminal" && row.phase === "matrix")
  if (!ar || !br) throw new Error("Fixture missing cell")
  ar.ok = false
  ar.errors = ["baseline semantic failure"]
  ar.classification = "semantic_mismatch"
  const improved = qualifyUnits(units, "experiment", "sha")
  expect(improved.completed).toBe(true)
  expect(improved.matrix.wire.comparisons.length).toBe(126)
  expect(improved.matrix.wire.improvements.length).toBe(1)
  br.ok = false
  br.errors = ["candidate semantic failure"]
  br.classification = "semantic_mismatch"
  const inherited = qualifyUnits(units, "experiment", "sha")
  expect(inherited.completed).toBe(true)
  expect(inherited.collectionCompleted).toBe(true)
  expect(inherited.noRegression).toBe(true)
  expect(inherited.baselineFailures).toEqual([ar])
  expect(inherited.candidateFailures).toEqual([br])
  expect(inherited.regressions).toEqual([])
  expect(inherited.matrix.wire.sharedFailures[0]?.status).toBe("unresolved_shared_failure")
  expect(inherited.matrix.wire.sharedFailures[0]?.baseline.errors).toEqual(["baseline semantic failure"])
  expect(inherited.matrix.wire.sharedFailures[0]?.candidate.errors).toEqual(["candidate semantic failure"])
  ar.ok = true
  ar.errors = []
  ar.classification = "success"
  const regressed = qualifyUnits(units, "experiment", "sha")
  expect(regressed.completed).toBe(false)
  expect(regressed.collectionCompleted).toBe(true)
  expect(regressed.noRegression).toBe(false)
  expect(regressed.regressions).toEqual([br])
  br.transportCompleted = false
  b.receipt.evidence = collectionEvidence(b.rows, 150, b.receipt.flags)
  expect(qualifyUnits(units, "experiment", "sha").collectionCompleted).toBe(false)
})

function fidelity(units: UnitEvidence[], index: number, ordinary = false) {
  const unit = units[index]
  const row = unit?.rows.find(row => row.event === "terminal" && (ordinary ? row.phase !== "matrix" : row.phase === "matrix"))
  const record = unit?.rows.filter(row => row.event === "dump_readback").flatMap(row => row.records as Record<string, unknown>[]).find(record => record.logicalId === row?.id)
  if (!record) throw new Error("Missing test capture")
  return record.captureFidelity as { passed: boolean; errors: string[]; classification: string; evidence: { responseKey: string } }
}
test("capture fidelity has a separate regression gate and preserves improvements and all unresolved failed pairs", () => {
  const units = UNITS.map(evidence)
  const a = fidelity(units, 1), b = fidelity(units, 2)
  a.passed = false; a.classification = "frame_value_mismatch"; a.errors = ["baseline changed early output"]
  const improved = qualifyUnits(units, "experiment", "sha")
  expect(improved.completed).toBe(true)
  expect(improved.matrix.captureFidelity.improvements.length).toBe(1)
  expect(improved.matrix.captureFidelity.comparisons.length).toBe(126)
  b.passed = false; b.classification = "frame_value_mismatch"; b.errors = ["candidate different frame corruption"]
  const shared = qualifyUnits(units, "experiment", "sha")
  expect(shared.completed).toBe(true)
  expect(shared.matrix.captureFidelity.sharedFailures[0]?.baseline.errors).toEqual(a.errors)
  expect(shared.matrix.captureFidelity.sharedFailures[0]?.candidate.errors).toEqual(b.errors)
  expect(shared.matrix.captureFidelity.sharedFailures[0]?.status).toBe("unresolved_shared_failure")
  a.passed = true; a.classification = "exact_wire_frames"; a.errors = []
  const regression = qualifyUnits(units, "experiment", "sha")
  expect(regression.collectionCompleted).toBe(true)
  expect(regression.completed).toBe(false)
  expect(regression.matrix.captureFidelity.regressions.length).toBe(1)
  expect(regression.matrix.wire.noRegression).toBe(true)
})

test("unknown or inconsistent wire outcomes and ordinary wire failures cannot qualify", () => {
  for (const mutation of ["unknown", "pass_with_errors", "fail_without_errors", "pass_classification", "fail_classification", "ordinary"]) {
    const units = UNITS.map(evidence)
    const row = units[1]?.rows.find(row => row.event === "terminal" && (mutation === "ordinary" ? row.phase === "matrix_warmup" : row.phase === "matrix"))
    if (!row) throw new Error("Missing wire outcome")
    if (mutation === "unknown") row.classification = "unknown"
    else if (mutation === "pass_with_errors") row.errors = ["inconsistent failure"]
    else if (mutation === "fail_without_errors") { row.ok = false; row.classification = "semantic_mismatch" }
    else if (mutation === "pass_classification") row.classification = "semantic_mismatch"
    else if (mutation === "fail_classification") { row.ok = false; row.errors = ["failed success classification"] }
    else { row.ok = false; row.classification = "semantic_mismatch"; row.errors = ["ordinary warmup failure"] }
    expect(qualifyUnits(units, "experiment", "sha").collectionCompleted).toBe(false)
  }
})
test("unknown, missing, duplicate and mismatched capture outcomes and ordinary failures cannot qualify", () => {
  for (const mutation of ["missing", "duplicate", "unknown", "wrong_evidence", "ordinary"]) {
    const units = UNITS.map(evidence)
    const unit = units[1]
    if (!unit) throw new Error("Missing matrix fixture")
    const event = unit.rows.find(row => row.event === "dump_readback")
    if (!event) throw new Error("Missing capture event")
    if (mutation === "missing") unit.rows.splice(unit.rows.indexOf(event), 1)
    else if (mutation === "duplicate") unit.rows.push(structuredClone(event))
    else if (mutation === "unknown") fidelity(units, 1).classification = "unknown"
    else if (mutation === "wrong_evidence") fidelity(units, 1).evidence.responseKey = "unrelated"
    else { const result = fidelity(units, 1, true); result.passed = false; result.classification = "frame_value_mismatch"; result.errors = ["warmup capture mismatch"] }
    expect(qualifyUnits(units, "experiment", "sha").collectionCompleted).toBe(false)
  }
})
