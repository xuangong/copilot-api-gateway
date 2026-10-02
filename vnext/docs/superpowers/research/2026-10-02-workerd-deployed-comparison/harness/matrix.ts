import type { Event } from "./journal.ts"
import type { CaptureFidelity } from "./readback.ts"
import { PROTOCOLS, SCENARIOS } from "./types.ts"

type Cell = [string, string, string, boolean]
export interface OracleOutcome {
  cell: Cell; logicalId: string; recordId: string; passed: boolean; errors: string[]; classification: string
  evidence: { wireEvidence: string; requestSha256: string; responseSha256: string; captureFidelity: CaptureFidelity }
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0)
const classifications = new Map<string, boolean>([["exact_wire_bytes", true], ["exact_wire_frames", true], ["renderer_appended_error", true], ["canonical_source_semantics", true], ["wire_bytes_mismatch", false], ["frame_value_mismatch", false], ["canonical_semantics_mismatch", false]])
// Fault classifications may pass or fail according to the strict oracle's errors.
const wireClassifications = new Map<string, boolean | null>([["success", true], ["expected_refusal", true], ["semantic_mismatch", false], ["transport_or_parse_failure", false], ["false_success", false], ["http_failure", null], ["explicit_failure", null], ["truncated_no_terminal", null]])
function compare(a: OracleOutcome[], b: OracleOutcome[], expected: number) {
  const key = (row: OracleOutcome) => JSON.stringify(row.cell)
  const before = new Map(a.map(row => [key(row), row]))
  const pairs = b.flatMap(candidate => { const baseline = before.get(key(candidate)); return baseline ? [{ cell: candidate.cell, baseline, candidate }] : [] })
  const regressions = pairs.filter(pair => pair.baseline.passed && !pair.candidate.passed)
  return {
    comparisons: pairs,
    baselineFailures: a.filter(row => !row.passed), candidateFailures: b.filter(row => !row.passed), regressions,
    improvements: pairs.filter(pair => !pair.baseline.passed && pair.candidate.passed),
    sharedFailures: pairs.filter(pair => !pair.baseline.passed && !pair.candidate.passed).map(pair => ({ ...pair, status: "unresolved_shared_failure" as const })),
    noRegression: a.length === expected && b.length === expected && new Set(a.map(key)).size === expected && new Set(b.map(key)).size === expected && pairs.length === expected && regressions.length === 0,
  }
}
/** Independent binary wire/capture outcomes; failed pairs are unresolved, never assumed equivalent. */
export function matrixOutcomes(rows: Event[], canary = false) {
  const errors: string[] = []
  const terminals = rows.filter(row => row.event === "terminal")
  const captures = rows.filter(row => row.event === "dump_readback").flatMap(row => Array.isArray(row.records) ? row.records.map(record => ({ variant: row.variant, record: object(record) })) : [])
  if (captures.length !== terminals.length) errors.push("Missing or extra capture outcomes")
  const ids = new Set<unknown>(), recordIds = new Set<unknown>()
  for (const { variant, record } of captures) {
    if (!record || ids.has(record.logicalId) || recordIds.has(record.recordId) || !terminals.some(row => row.id === record.logicalId && row.variant === variant)) errors.push("Unknown or duplicate capture outcome")
    ids.add(record?.logicalId); recordIds.add(record?.recordId)
  }
  const wire: { A: OracleOutcome[]; B: OracleOutcome[] } = { A: [], B: [] }
  const fidelity: { A: OracleOutcome[]; B: OracleOutcome[] } = { A: [], B: [] }
  for (const row of terminals) {
    const actual = captures.filter(entry => entry.record?.logicalId === row.id && entry.variant === row.variant)
    const record = actual[0]?.record
    const capture = object(record?.captureFidelity)
    const evidence = object(capture?.evidence)
    const response = Array.isArray(record?.objects) ? record.objects.map(object).filter(value => value?.side === "response") : []
    const wireClassification = wireClassifications.get(String(row.classification))
    const validWire = typeof row.ok === "boolean" && strings(row.errors) && (row.ok ? row.errors.length === 0 : row.errors.length > 0)
      && wireClassifications.has(String(row.classification)) && (wireClassification === null || wireClassification === row.ok)
    const validCapture = actual.length === 1 && record?.recordId === row.dumpRecordId && record?.status === row.status
      && capture?.comparator === "response-frame-fidelity-v1" && typeof capture.passed === "boolean" && classifications.get(String(capture.classification)) === capture.passed
      && strings(capture.errors) && (capture.passed ? capture.errors.length === 0 : capture.errors.length > 0)
      && hash(capture.storedSha256) && hash(capture.wireSha256) && capture.wireSha256 === row.responseSha256
      && hash(row.requestSha256) && typeof row.wireEvidence === "string" && row.wireEvidence.length > 0
      && evidence?.wireEvidence === row.wireEvidence && response.length === 1 && capture.storedSha256 === response[0]?.sha256
      && evidence?.responseKey === response[0]?.key && evidence?.responseType === response[0]?.type && object(capture.details) !== null
    if (!validWire || !validCapture) { errors.push(`Missing, unknown or inconsistent oracle outcome ${row.id}`); continue }
    if (row.phase !== "matrix") {
      if (!row.ok || !capture.passed) errors.push(`Ordinary strict oracle failure ${row.id}`)
      continue
    }
    if ((row.variant !== "A" && row.variant !== "B") || !PROTOCOLS.includes(row.protocol as typeof PROTOCOLS[number]) || !PROTOCOLS.includes(row.upstream as typeof PROTOCOLS[number]) || !SCENARIOS.includes(String(row.scenario)) || typeof row.stream !== "boolean" || row.bytes !== 65536) { errors.push(`Unknown matrix cell ${row.id}`); continue }
    const cell: Cell = [String(row.protocol), String(row.upstream), String(row.scenario), row.stream]
    const common = { cell, logicalId: String(row.id), recordId: String(row.dumpRecordId), evidence: { wireEvidence: String(row.wireEvidence), requestSha256: String(row.requestSha256), responseSha256: String(row.responseSha256), captureFidelity: capture as unknown as CaptureFidelity } }
    wire[row.variant].push({ ...common, passed: row.ok as boolean, errors: row.errors as string[], classification: String(row.classification) })
    fidelity[row.variant].push({ ...common, passed: capture.passed as boolean, errors: capture.errors as string[], classification: String(capture.classification) })
  }
  const expected = canary ? 0 : 126
  for (const variant of ["A", "B"] as const) if (wire[variant].length !== expected || fidelity[variant].length !== expected) errors.push(`Incomplete matrix oracle outcomes ${variant}`)
  return { errors, matrix: { cells: { A: wire.A.length, B: wire.B.length }, wire: compare(wire.A, wire.B, expected), captureFidelity: compare(fidelity.A, fidelity.B, expected) } }
}
