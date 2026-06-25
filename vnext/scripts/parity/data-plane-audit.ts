#!/usr/bin/env bun
/**
 * Spec 12a — Data-Plane Parity Audit harness.
 *
 * Compares root src/ (PORT=4141) and vnext (PORT=41415) across 27 fixtures.
 * Emits structural diff report to vnext/docs/superpowers/research/.
 *
 * Spec: vnext/docs/superpowers/specs/2026-06-25-spec12a-data-plane-parity-audit.md
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------- Types ----------

export type GapLabel = 'parity' | 'cosmetic-diff' | 'behavior-gap' | 'route-missing'

export interface Fixture {
  name: string
  endpoint: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: unknown
  expect_stream: boolean
}

export interface FetchResult {
  status: number
  headers: Record<string, string>
  // For non-stream: parsed JSON or raw text fallback.
  // For stream: raw SSE text body.
  body: unknown
  raw: string
}

export interface DiffEntry {
  layer: 'status' | 'header' | 'body' | 'sse'
  label: GapLabel
  detail: string
}

export interface FixtureReport {
  fixture: string
  endpoint: string
  rootStatus: number
  vnextStatus: number
  label: GapLabel
  diffs: DiffEntry[]
}

// ---------- Env / config ----------

const ROOT_BASE = process.env.PARITY_ROOT_BASE ?? 'http://127.0.0.1:4141'
const VNEXT_BASE = process.env.PARITY_VNEXT_BASE ?? 'http://127.0.0.1:41415'
const API_KEY = process.env.PARITY_API_KEY ?? ''
const FIXTURE_DIR = join(import.meta.dir, 'fixtures/data-plane')
const REPORT_PATH = process.env.PARITY_REPORT_PATH
  ?? join(import.meta.dir, '../../docs/superpowers/research/2026-06-25-spec12a-parity-report.md')

// ---------- Fixture loader ----------

export function loadFixtures(dir: string = FIXTURE_DIR): Fixture[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  return files.map((f) => {
    const raw = readFileSync(join(dir, f), 'utf8')
    const fx = JSON.parse(raw) as Fixture
    // Substitute ${API_KEY} in headers
    for (const [k, v] of Object.entries(fx.headers ?? {})) {
      fx.headers[k] = v.replace(/\$\{API_KEY\}/g, API_KEY)
    }
    return fx
  })
}

// ---------- CLI entry (stub for Part 1) ----------

async function main(): Promise<void> {
  console.error('[parity] harness Part 1 skeleton — real runner wired in Part 3')
  console.error(`[parity] root=${ROOT_BASE} vnext=${VNEXT_BASE} fixtures=${FIXTURE_DIR}`)
  console.error(`[parity] report→${REPORT_PATH}`)
  process.exit(0)
}

if (import.meta.main) {
  await main()
}
