import { test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { OPTIONAL_FLAGS } from '../../../src/data-plane/flags/catalog'

// A flag is only real when the catalog entry and a runtime read agree. Drift
// either way is silent: an id nobody reads is a switch that does nothing, and
// an id nobody catalogs can never be turned on (the control plane rejects
// unknown overrides). Both defects shipped undetected before this test —
// `responses-web-search-shim` sat unreachable for months, and
// `promote-thinking-display` sat unread just as long. Source scanning is the
// only way to catch it, because neither half fails to compile.

const PACKAGES_ROOT = join(import.meta.dir, '../../../../')

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'tests') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* sourceFiles(full)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) yield full
  }
}

/** `enabledFlags.has('x')` / `flags.has("x")` — the only ways a flag is read. */
const READ_PATTERN = /(?:enabledFlags|flags)\.has\(\s*['"]([\w-]+)['"]\s*\)/g

const flagsReadInSource = (() => {
  const found = new Set<string>()
  for (const pkg of readdirSync(PACKAGES_ROOT)) {
    let src: string
    try {
      src = join(PACKAGES_ROOT, pkg, 'src')
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    for (const file of sourceFiles(src)) {
      // Read as text rather than shelling out to grep: several sources carry
      // bytes that make grep classify them as binary and skip them silently.
      for (const m of readFileSync(file, 'utf8').matchAll(READ_PATTERN)) found.add(m[1]!)
    }
  }
  return found
})()

test('every catalog flag is read by some interceptor', () => {
  const dead = OPTIONAL_FLAGS.map((f) => f.id).filter(
    (id) => !flagsReadInSource.has(id) && !id.startsWith('vendor-'),
  )
  expect(dead).toEqual([])
})

test('every flag read at runtime is in the catalog', () => {
  const known = new Set<string>(OPTIONAL_FLAGS.map((f) => f.id))
  expect([...flagsReadInSource].filter((id) => !known.has(id)).sort()).toEqual([])
})

// Vendor flags are data-only: other interceptors dispatch on them, so they
// legitimately have no gate of their own. They still must be readable
// somewhere, otherwise they mean nothing at all.
test('vendor flags are consulted somewhere', () => {
  const vendors = OPTIONAL_FLAGS.map((f) => f.id).filter((id) => id.startsWith('vendor-'))
  expect(vendors.filter((id) => !flagsReadInSource.has(id))).toEqual([])
})
