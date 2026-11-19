/**
 * Every GitHub REST / OAuth URL must be derived from the account's GitHub host
 * (github.com or a SUBDOMAIN.ghe.com tenant) through shared/config/github-host.ts.
 *
 * A hardcoded `https://api.github.com` or `https://github.com/login` elsewhere
 * silently sends a GHE.com tenant's token to github.com: the call fails (quota
 * shows an error, a valid token is reported invalid) and the token reaches the
 * wrong GitHub instance. This happened in the copilot-quota and
 * github-accounts routes after GHE login landed, so the rule is enforced here
 * rather than by review.
 */
import { expect, test } from 'bun:test'
import { Glob } from 'bun'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '../../src')
const ALLOWED = new Set(['shared/config/github-host.ts'])
const HARDCODED = /https:\/\/(api\.github\.com|github\.com\/login)/

test('no gateway source file hardcodes a github.com REST or OAuth origin', async () => {
  const offenders: string[] = []
  for await (const rel of new Glob('**/*.ts').scan(SRC)) {
    if (ALLOWED.has(rel) || rel.includes('__tests__') || rel.includes('/i18n.ts')) continue
    const text = await Bun.file(join(SRC, rel)).text()
    text.split('\n').forEach((line, i) => {
      const code = line.replace(/(^|\s)\/\/.*$/, '')
      if (!/^\s*\*/.test(line) && HARDCODED.test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
    })
  }
  expect(offenders).toEqual([])
})
