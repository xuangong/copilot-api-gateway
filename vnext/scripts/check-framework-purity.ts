#!/usr/bin/env bun
/**
 * Framework-purity gate. Run before the test suite via `bun run test`.
 *
 * Rejects two classes of violation:
 *
 *   1. Any package whose name starts with `@vnext-gateway/` must NOT import
 *      anything from `@vnext-llm/*` — neither in `.ts`/`.tsx` source nor in
 *      its package.json dependencies. This enforces Charter §6 framework
 *      purity.
 *
 *   2. Any source file under `vnext/packages/*` or `vnext/apps/*` must NOT
 *      import an un-scoped `@vnext/*` specifier. After Spec 8, every package
 *      is `@vnext-gateway/*` or `@vnext-llm/*`. A bare `@vnext/foo` import
 *      is a habit-revert from the pre-rename naming and is always a bug.
 *
 * Exit code: 0 if clean, 1 if any violation. Prints `file:line  →  matched
 * substring` for each violation so the offending import is grep-jumpable.
 *
 * Allowlist: vnext/scripts/, vnext/docs/, vnext/package.json. Historical
 * mentions of @vnext/* in design docs are expected and permitted.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const PACKAGE_ROOTS = [join(ROOT, 'packages'), join(ROOT, 'apps')]
const SOURCE_EXTS = new Set(['.ts', '.tsx'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage'])

interface Violation {
  file: string
  line: number
  matched: string
  reason: string
}

const violations: Violation[] = []

function walk(dir: string, visit: (file: string) => void) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, visit)
    else visit(full)
  }
}

function scanFile(file: string, predicate: (line: string) => string | null, reason: string) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const hit = predicate(lines[i])
    if (hit) {
      violations.push({
        file: relative(ROOT, file),
        line: i + 1,
        matched: hit,
        reason,
      })
    }
  }
}

// Pattern 1: any source file importing an un-scoped @vnext/* specifier.
// Matches: from '@vnext/foo', from "@vnext/foo", import('@vnext/foo'),
// import '@vnext/foo' (side-effect), export ... from '@vnext/foo'.
const UNSCOPED_VNEXT = /(?:from|import)\s*\(?\s*['"]@vnext\/[a-z0-9-]+/i

// Pattern 2: @vnext-gateway/* package importing @vnext-llm/*.
const LLM_IMPORT = /(?:from|import)\s*\(?\s*['"]@vnext-llm\/[a-z0-9-]+/i

for (const root of PACKAGE_ROOTS) {
  for (const pkgDir of readdirSync(root)) {
    const pkgPath = join(root, pkgDir)
    if (!statSync(pkgPath).isDirectory()) continue

    const manifestPath = join(pkgPath, 'package.json')
    let manifest: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }

    const isFramework = manifest.name?.startsWith('@vnext-gateway/')

    // Manifest check: framework packages must not depend on @vnext-llm/*
    if (isFramework) {
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        const deps = manifest[key] ?? {}
        for (const dep of Object.keys(deps)) {
          if (dep.startsWith('@vnext-llm/')) {
            violations.push({
              file: relative(ROOT, manifestPath),
              line: 0,
              matched: `${key}: ${dep}`,
              reason: `${manifest.name} (framework) depends on ${dep} (business)`,
            })
          }
        }
      }
    }

    // Source check
    walk(pkgPath, (file) => {
      const dot = file.lastIndexOf('.')
      if (dot < 0) return
      if (!SOURCE_EXTS.has(file.slice(dot))) return

      scanFile(
        file,
        (line) => {
          const m = line.match(UNSCOPED_VNEXT)
          return m ? m[0] : null
        },
        'un-scoped @vnext/* import (use @vnext-gateway/* or @vnext-llm/*)',
      )

      if (isFramework) {
        scanFile(
          file,
          (line) => {
            const m = line.match(LLM_IMPORT)
            return m ? m[0] : null
          },
          `${manifest.name} (framework) imports @vnext-llm/* (business)`,
        )
      }
    })
  }
}

if (violations.length === 0) {
  console.log('[framework-purity] OK')
  process.exit(0)
}

console.error('[FRAMEWORK PURITY VIOLATION]')
for (const v of violations) {
  const loc = v.line > 0 ? `${v.file}:${v.line}` : v.file
  console.error(`  ${loc}  →  ${v.matched}`)
  console.error(`    ${v.reason}`)
}
process.exit(1)
