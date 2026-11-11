// The server-rendered pages (login, device, guide) carry a hand-copied set of
// the dashboard's colour tokens in ui-pages/layout.ts. These tests keep the
// copy honest: every token both files define must have the same value in each
// theme, and every `-rgb` channel triple must match its hex token.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..', '..')
const layoutSource = await Bun.file(
  join(root, 'packages/gateway/src/shared/edge/ui-pages/layout.ts'),
).text()
const dashboardCss = await Bun.file(join(root, 'apps/dashboard/src/styles.css')).text()

type Theme = 'light' | 'dark'

function block(source: string, theme: Theme): string {
  const opener = theme === 'light' ? '[data-theme="light"] {' : '[data-theme="dark"] {'
  const start = source.indexOf(opener)
  if (start < 0) throw new Error(`no ${theme} token block`)
  const end = source.indexOf('}', start)
  return source.slice(start + opener.length, end)
}

function tokens(source: string, theme: Theme): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of block(source, theme).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1]!, m[2]!.trim().toLowerCase())
  }
  return out
}

function resolve(map: Map<string, string>, value: string): string {
  const ref = /^var\((--[\w-]+)\)$/.exec(value)
  return ref && map.has(ref[1]!) ? resolve(map, map.get(ref[1]!)!) : value
}

function hexToChannels(hex: string): string | null {
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/.exec(hex)
  if (!m) return null
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ')
}

describe.each(['light', 'dark'] as const)('server page tokens (%s)', (theme) => {
  const page = tokens(layoutSource, theme)
  const dashboard = tokens(dashboardCss, theme)

  test('shared tokens match the dashboard', () => {
    const shared = [...page.keys()].filter((k) => dashboard.has(k))
    expect(shared.length).toBeGreaterThan(15)
    const mismatches = shared
      .filter((k) => resolve(page, page.get(k)!) !== resolve(dashboard, dashboard.get(k)!))
      .map((k) => `${k}: page ${page.get(k)} vs dashboard ${dashboard.get(k)}`)
    expect(mismatches).toEqual([])
  })

  test('rgb channel tokens match their hex token', () => {
    const channels = [...page.keys()].filter((k) => k.endsWith('-rgb'))
    expect(channels.length).toBeGreaterThan(10)
    const mismatches = channels.flatMap((k) => {
      const base = k.slice(0, -'-rgb'.length)
      const expected = hexToChannels(resolve(page, page.get(base) ?? ''))
      const actual = page.get(k)!.replace(/\s+/g, ' ')
      return expected === actual ? [] : [`${k}: ${actual} vs ${base} → ${expected}`]
    })
    expect(mismatches).toEqual([])
  })
})
