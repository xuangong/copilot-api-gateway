#!/usr/bin/env bun
/**
 * extract-vscode-github-token — read a GitHub OAuth token from VS Code's
 * safeStorage on macOS and print it to stdout, so the user can paste it
 * into the gateway's Path B (POST /control-plane/auth/github/paste-token).
 *
 * Why this exists:
 *   GHE-with-data-residency tenants (SUBDOMAIN.ghe.com) can't OAuth against
 *   our client_id, but VS Code's github-authentication extension already
 *   holds a valid token in state.vscdb (encrypted at rest via Chromium's
 *   safeStorage, which on macOS wraps AES-128 with a Keychain-derived key).
 *
 * Platform: macOS only for now. Linux / Windows use different key derivation
 *   (kwallet / DPAPI) and are TODO.
 *
 * Usage:
 *   bun run vnext/tools/extract-vscode-github-token.ts [--host <host>] [--json] [--verbose] [--edition <stable|insiders>]
 *
 * Defaults:
 *   --host      github.com
 *   --edition   stable
 *
 * Output:
 *   stdout: the token string (or JSON with --json)
 *   stderr: verbose info + errors (never mixed with the token itself)
 */
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'

interface Args {
  host: string
  json: boolean
  verbose: boolean
  edition: 'stable' | 'insiders'
}

function parseArgs(argv: string[]): Args {
  const out: Args = { host: 'github.com', json: false, verbose: false, edition: 'stable' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--host' && argv[i + 1]) { out.host = argv[++i]!; continue }
    if (a === '--json') { out.json = true; continue }
    if (a === '--verbose' || a === '-v') { out.verbose = true; continue }
    if (a === '--edition' && argv[i + 1]) {
      const v = argv[++i]!
      if (v !== 'stable' && v !== 'insiders') throw new Error(`--edition must be stable|insiders (got ${v})`)
      out.edition = v
      continue
    }
    if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return out
}

function printHelp(): void {
  process.stderr.write(`extract-vscode-github-token — extract a GitHub token from VS Code's safeStorage.

Usage:
  bun run vnext/tools/extract-vscode-github-token.ts [options]

Options:
  --host <host>                GitHub host (github.com or <tenant>.ghe.com). Default: github.com
  --edition <stable|insiders>  VS Code edition to read from. Default: stable
  --json                       Emit JSON { token, host } instead of just the token.
  --verbose, -v                Log discovery/decryption steps to stderr.
  --help, -h                   This help.

Then paste the token into the gateway:
  curl -X POST http://localhost:PORT/control-plane/auth/github/paste-token \\
    -H 'content-type: application/json' \\
    -d '{"github_token":"<paste>", "github_host":"msft.ghe.com"}'
`)
}

function log(v: boolean, msg: string): void {
  if (v) process.stderr.write(`[extract] ${msg}\n`)
}

function vscodeUserDir(edition: Args['edition']): string {
  const home = homedir()
  if (platform() === 'darwin') {
    return edition === 'insiders'
      ? join(home, 'Library', 'Application Support', 'Code - Insiders', 'User')
      : join(home, 'Library', 'Application Support', 'Code', 'User')
  }
  throw new Error(`Unsupported platform: ${platform()} (only darwin/macOS supported for now)`)
}

function keychainService(edition: Args['edition']): string {
  return edition === 'insiders' ? 'Code Insiders Safe Storage' : 'Code Safe Storage'
}

/**
 * Fetch the Chromium safeStorage password from the macOS Keychain.
 * The security(1) tool prints the password to stderr in the form
 * `password: "<value>"` — we parse that out.
 */
function readKeychainPassword(service: string, verbose: boolean): string {
  log(verbose, `reading keychain service="${service}"`)
  const result = spawnSync('security', ['find-generic-password', '-w', '-s', service], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`Failed to read Keychain (${service}): ${result.stderr || result.stdout}`)
  }
  const pw = (result.stdout ?? '').trim()
  if (!pw) throw new Error('Keychain returned an empty password')
  return pw
}

/**
 * Chromium's OSCrypt on macOS derives an AES-128 key by:
 *   PBKDF2-HMAC-SHA1(password, salt="saltysalt", iters=1003, keylen=16)
 * Then encrypts with AES-128-CBC using IV = " " * 16.
 *
 * Newer builds may use AES-128-GCM (prefix "v10"/"v11") with a random 12-byte
 * IV following the prefix. We try GCM first, fall back to CBC.
 */
function decryptSafeStorage(blob: Buffer, password: string, verbose: boolean): string {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const prefix = blob.slice(0, 3).toString('utf8')
  log(verbose, `blob length=${blob.length} prefix="${prefix}"`)

  if (prefix === 'v10' || prefix === 'v11') {
    // Try GCM first (recent Chromium): [3B prefix][12B iv][ciphertext][16B tag]
    try {
      const iv = blob.slice(3, 15)
      const tag = blob.slice(blob.length - 16)
      const ct = blob.slice(15, blob.length - 16)
      const decipher = createDecipheriv('aes-128-gcm', key, iv)
      decipher.setAuthTag(tag)
      const pt = Buffer.concat([decipher.update(ct), decipher.final()])
      log(verbose, `decrypted via AES-128-GCM (${pt.length} bytes)`)
      return pt.toString('utf8')
    } catch (e) {
      log(verbose, `GCM failed (${(e as Error).message}); trying CBC`)
      // Fall through to CBC path below.
    }

    // CBC fallback: [3B prefix][ciphertext], IV = " " * 16
    const iv = Buffer.alloc(16, 0x20)
    const ct = blob.slice(3)
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    log(verbose, `decrypted via AES-128-CBC v10/v11 (${pt.length} bytes)`)
    return pt.toString('utf8')
  }

  // No prefix — legacy CBC-only.
  const iv = Buffer.alloc(16, 0x20)
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  const pt = Buffer.concat([decipher.update(blob), decipher.final()])
  log(verbose, `decrypted via legacy AES-128-CBC (${pt.length} bytes)`)
  return pt.toString('utf8')
}

/**
 * Look up the GitHub-authentication secret in VS Code's state.vscdb.
 * Rows live in the `ItemTable` table; the key we want is
 *   secret://{"extensionId":"vscode.github-authentication","key":"<host>/.ghes.auth"}
 * (or ".auth" for github.com sessions).
 */
/**
 * VS Code stores the safeStorage blob in ItemTable.value in one of three forms:
 *   1. Raw BLOB bytes (older builds)
 *   2. TEXT containing JSON: {"type":"Buffer","data":[...]}  (current builds)
 *   3. TEXT containing base64 (some forks)
 * Normalize to a Buffer of the actual encrypted bytes (starting with "v10"/"v11").
 */
function unwrapBlob(value: Buffer | Uint8Array | string, verbose: boolean): Buffer {
  const asBuf = typeof value === 'string' ? Buffer.from(value, 'utf8')
    : Buffer.isBuffer(value) ? value : Buffer.from(value)
  const head = asBuf.slice(0, 32).toString('utf8')
  if (head.startsWith('{"type":"Buffer"')) {
    log(verbose, 'unwrapping {"type":"Buffer","data":[...]} JSON envelope')
    const parsed = JSON.parse(asBuf.toString('utf8')) as { type: string; data: number[] }
    return Buffer.from(parsed.data)
  }
  return asBuf
}

function loadSecretBlob(vscdbPath: string, host: string, verbose: boolean): Buffer {
  log(verbose, `opening ${vscdbPath}`)
  if (!existsSync(vscdbPath)) throw new Error(`state.vscdb not found at ${vscdbPath}`)
  const db = new Database(vscdbPath, { readonly: true })
  try {
    // github-authentication stores secrets keyed by host. github.com uses ".auth";
    // GHE tenants use "<host>/.ghes.auth". We match both patterns.
    const candidates =
      host === 'github.com'
        ? [
            'secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}',
            'secret://{"extensionId":"vscode.github-authentication","key":".auth"}',
          ]
        : [
            `secret://{"extensionId":"vscode.github-authentication","key":"${host}/.ghes.auth"}`,
            `secret://{"extensionId":"vscode.github-authentication","key":"${host}.auth"}`,
          ]
    for (const key of candidates) {
      const row = db.query<{ value: Buffer | Uint8Array | string }, [string]>(
        'SELECT value FROM ItemTable WHERE key = ?',
      ).get(key)
      if (row) {
        log(verbose, `found key "${key}"`)
        return unwrapBlob(row.value, verbose)
      }
      log(verbose, `key "${key}" not found`)
    }
    // Last resort: enumerate all github-authentication keys to help the user.
    const all = db.query<{ key: string }, []>(
      "SELECT key FROM ItemTable WHERE key LIKE 'secret://{\"extensionId\":\"vscode.github-authentication%'",
    ).all()
    const known = all.map((r) => r.key).join('\n  ')
    throw new Error(
      `No github-authentication secret matched host="${host}".\nKeys present in state.vscdb:\n  ${known || '(none)'}`,
    )
  } finally {
    db.close()
  }
}

/**
 * The decrypted secret is a JSON string containing an array of GitHub
 * "sessions", each with an accessToken. We return the first token (or
 * the one matching the host if multiple entries exist).
 */
function pickToken(decrypted: string, host: string, verbose: boolean): string {
  interface Session {
    accessToken?: string
    account?: { label?: string }
    scopes?: string[]
  }
  let parsed: Session[]
  try {
    parsed = JSON.parse(decrypted) as Session[]
  } catch {
    throw new Error('Decrypted secret is not valid JSON — token format changed?')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Decrypted secret contains no sessions')
  }
  log(verbose, `found ${parsed.length} session(s)`)
  const first = parsed.find((s) => typeof s.accessToken === 'string' && s.accessToken.length > 0)
  if (!first?.accessToken) throw new Error(`No accessToken present in sessions for host=${host}`)
  return first.accessToken
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  log(args.verbose, `host=${args.host} edition=${args.edition}`)

  const userDir = vscodeUserDir(args.edition)
  const vscdbPath = join(userDir, 'globalStorage', 'state.vscdb')
  const password = readKeychainPassword(keychainService(args.edition), args.verbose)
  const blob = loadSecretBlob(vscdbPath, args.host, args.verbose)
  const decrypted = decryptSafeStorage(blob, password, args.verbose)
  const token = pickToken(decrypted, args.host, args.verbose)

  if (args.json) {
    process.stdout.write(JSON.stringify({ token, host: args.host }) + '\n')
  } else {
    process.stdout.write(token + '\n')
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
