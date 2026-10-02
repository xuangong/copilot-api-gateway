export type Variant = "A" | "B"
export type Protocol = "responses" | "chat" | "messages"
export interface Cell { protocol: Protocol; upstream: Protocol; scenario: string; bytes: number; stream: boolean }
export interface Dispatch {
  id: string; status: number; requestBase64: string; bodyCompleted: boolean; protocol: string; scenario: string; completed: boolean; cancelled: boolean
  bodyBytes: number; requestPrefixSha256: string; responseBytes: number
  responsePrefixSha256: string; responsePrefixBase64: string
}
export interface Row extends Cell {
  event: "terminal"; variant: Variant; phase: string; block: number; id: string; status: number
  eofMs: number | null; failureElapsedMs: number | null; firstSemanticMs: number | null; terminalMs: number | null
  transportCompleted: boolean; responseBytes: number; wireBytes: number
  responseSha256: string; requestSha256: string; dumpRecordId: string | null
  wireEvents: unknown[]; wireDone: boolean; ok: boolean; errors: string[]; classification: string
  wireEvidence: string
}
export const PROTOCOLS: Protocol[] = ["responses", "chat", "messages"]
export const SCENARIOS = ["ok", "tool", "refusal", "failed", "truncated", "http503", "slow"]
export const API_KEY = "sk_architecture_fixture_local_only"
export const FIXTURE_SECRET = "architecture-fixture-local-only"
export const hot = (stream: boolean): Cell => ({ protocol: "responses", upstream: "responses", scenario: "ok", bytes: 65536, stream })
export const UNITS = ["latency-pair", "A-matrix", "B-matrix", "B-diagnostic", "A-diagnostic"] as const
export type Unit = typeof UNITS[number]
export const EXPECTED: Record<Unit, number> = { "latency-pair": 208, "A-matrix": 150, "B-matrix": 150, "B-diagnostic": 104, "A-diagnostic": 104 }
