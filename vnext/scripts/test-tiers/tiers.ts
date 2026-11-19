/**
 * Test tiers, derived from file names:
 *
 * - `fast`     — everything that runs in-process: pure units, Hono
 *                `app.request` tests (including `.e2e.`), in-memory SQLite.
 * - `slow`     — `.proc.` (starts real processes), `.d1.` (Miniflare D1),
 *                `.workerd.` (workerd runtime).
 * - `research` — measurement harnesses under docs/superpowers/research.
 *
 * `bun test` (CI) still runs every tier; `bun run test:fast` is the local loop.
 */
import { Glob } from "bun"

export type TestTier = "fast" | "slow" | "research"

const SLOW = /\.(proc|d1|workerd)\.test\.tsx?$/

export function classifyTestFile(relPath: string): TestTier {
  if (relPath.startsWith("docs/")) return "research"
  return SLOW.test(relPath) ? "slow" : "fast"
}

/** True when source text starts a real OS process. */
export function spawnsProcess(source: string): boolean {
  return /\bBun\.spawn(Sync)?\s*\(/.test(source) || /from\s+["'](node:)?child_process["']/.test(source)
}

export async function listTestFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for await (const rel of new Glob("**/*.test.{ts,tsx}").scan({ cwd: root, onlyFiles: true })) {
    if (rel.includes("node_modules/") || rel.includes("/dist/")) continue
    files.push(rel)
  }
  return files.sort()
}
