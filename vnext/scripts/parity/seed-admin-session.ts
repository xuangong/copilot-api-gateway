/**
 * Seed both root and vnext databases with a deterministic admin user,
 * target user, admin session (ses_-prefixed) and admin API key.
 *
 * Usage:
 *   bun vnext/scripts/parity/seed-admin-session.ts \
 *     --root-db ./.data/copilot.db \
 *     --vnext-db ./data-vnext/vnext.sqlite \
 *     [--clean]
 *
 * --clean: before seeding, wipe rows from tables whose state confounds parity
 * diffs (extra api-keys, observability shares, upstreams, github accounts).
 * The seeded admin user + target user + bootstrap api-key are re-inserted
 * after the wipe.
 *
 * Echoes 8 env exports to stdout. Pipe to a file or eval to inject into the
 * control-plane harness shell.
 */
import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'

export const PARITY_ADMIN_USER_ID = '00000000-0000-4000-a000-0000000000a1'
export const PARITY_ADMIN_USER_EMAIL = 'test@local.dev'
export const PARITY_TARGET_USER_ID = '00000000-0000-4000-a000-0000000000b2'
export const PARITY_TARGET_USER_EMAIL = 'parity-target@local.dev'

export function buildSessionToken(): string {
  return 'ses_' + randomBytes(24).toString('hex')
}

export function buildApiKey(): string {
  return 'sk_parity_' + randomBytes(16).toString('hex')
}

export interface SeedRows {
  users: Array<{ id: string; name: string; email: string }>
  session: { token: string; userId: string; createdAt: string; expiresAt: string }
  apiKey: { id: string; ownerId: string; key: string; name: string; createdAt: string }
}

export function buildSeedRows(token: string): SeedRows {
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  return {
    users: [
      { id: PARITY_ADMIN_USER_ID, name: 'Parity Admin', email: PARITY_ADMIN_USER_EMAIL },
      { id: PARITY_TARGET_USER_ID, name: 'Parity Target', email: PARITY_TARGET_USER_EMAIL },
    ],
    session: { token, userId: PARITY_ADMIN_USER_ID, createdAt: now, expiresAt },
    apiKey: {
      id: '00000000-0000-4000-a000-0000000000c3',
      ownerId: PARITY_ADMIN_USER_ID,
      key: buildApiKey(),
      name: 'parity-admin-bootstrap',
      createdAt: now,
    },
  }
}

/**
 * Wipe rows whose presence makes diffs noisy (counts, ids, names that differ
 * by side). Leaves schema and admin user tables intact — they get repopulated
 * by applyRows() below. Tables not present on a side are silently skipped.
 *
 * `users` rows other than the parity-managed ones (admin + target) are also
 * removed: stale seeds from earlier docker boots (e.g. "Dev User") share
 * test@local.dev with the parity admin and cause findByEmail to return the
 * wrong row, leaking non-deterministic name/id into responses.
 */
export function cleanForParity(db: Database): void {
  const exists = (name: string): boolean => {
    const r = db.query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name)
    return !!r
  }
  // Order matters where FKs would apply; here we use plain DELETE which is fine
  // since SQLite without foreign_keys=ON skips constraint checks.
  const tablesToWipe = [
    'api_keys', 'observability_shares', 'key_assignments',
    'upstreams', 'github_accounts', 'usage', 'usage_requests',
    'web_search_engine_usage', 'web_search_usage',
    'latency', 'performance_summary', 'performance_latency_buckets',
    'client_presence', 'device_codes', 'invite_codes',
    'responses_items',
  ]
  for (const t of tablesToWipe) {
    if (exists(t)) db.run(`DELETE FROM ${t}`)
  }
  // Remove non-parity user rows so duplicate emails don't shadow the seeded
  // admin. user_sessions has no FK to users in vnext, but rows pointing at
  // a deleted user are dead weight — drop them too.
  if (exists('users')) {
    db.run(
      `DELETE FROM users WHERE id NOT IN (?, ?)`,
      [PARITY_ADMIN_USER_ID, PARITY_TARGET_USER_ID],
    )
  }
  if (exists('user_sessions')) {
    db.run(
      `DELETE FROM user_sessions WHERE user_id NOT IN (?, ?)`,
      [PARITY_ADMIN_USER_ID, PARITY_TARGET_USER_ID],
    )
  }
}

function applyRows(db: Database, rows: SeedRows): void {
  // user_sessions / users / api_keys schemas verified against both root and vnext.
  // INSERT OR REPLACE so re-runs are idempotent.
  for (const u of rows.users) {
    db.run(
      `INSERT OR REPLACE INTO users
       (id, name, email, avatar_url, created_at, disabled, last_login_at, user_key, password_hash)
       VALUES (?, ?, ?, NULL, ?, 0, NULL, NULL, NULL)`,
      [u.id, u.name, u.email, new Date().toISOString()],
    )
  }
  db.run(
    `INSERT OR REPLACE INTO user_sessions (token, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
    [rows.session.token, rows.session.userId, rows.session.createdAt, rows.session.expiresAt],
  )
  db.run(
    `INSERT OR REPLACE INTO api_keys
     (id, name, key, created_at, last_used_at, owner_id,
      quota_requests_per_day, quota_tokens_per_day,
      web_search_enabled, web_search_langsearch_key, web_search_tavily_key,
      web_search_ms_grounding_key, web_search_priority,
      web_search_langsearch_ref, web_search_tavily_ref, web_search_ms_grounding_ref)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    [rows.apiKey.id, rows.apiKey.name, rows.apiKey.key, rows.apiKey.createdAt, rows.apiKey.ownerId],
  )
}

function parseArgs(): { rootDb: string; vnextDb: string; clean: boolean } {
  const argv = process.argv.slice(2)
  const map: Record<string, string> = {}
  let clean = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--clean') {
      clean = true
      continue
    }
    if (a.startsWith('--') && i + 1 < argv.length) {
      map[a.slice(2)] = argv[i + 1]
      i++
    }
  }
  if (!map['root-db'] || !map['vnext-db']) {
    console.error('usage: --root-db <path> --vnext-db <path> [--clean]')
    process.exit(2)
  }
  return { rootDb: map['root-db'], vnextDb: map['vnext-db'], clean }
}

if (import.meta.main) {
  const { rootDb, vnextDb, clean } = parseArgs()

  const rootRows = buildSeedRows(buildSessionToken())
  const vnextRows = buildSeedRows(buildSessionToken())

  const rootHandle = new Database(rootDb)
  const vnextHandle = new Database(vnextDb)
  try {
    if (clean) {
      cleanForParity(rootHandle)
      cleanForParity(vnextHandle)
    }
    applyRows(rootHandle, rootRows)
    applyRows(vnextHandle, vnextRows)
  } finally {
    rootHandle.close()
    vnextHandle.close()
  }

  process.stdout.write([
    `export PARITY_ROOT_ADMIN_TOKEN='${rootRows.session.token}'`,
    `export PARITY_VNEXT_ADMIN_TOKEN='${vnextRows.session.token}'`,
    `export PARITY_ROOT_ADMIN_API_KEY='${rootRows.apiKey.key}'`,
    `export PARITY_VNEXT_ADMIN_API_KEY='${vnextRows.apiKey.key}'`,
    `export PARITY_ADMIN_USER_ID='${PARITY_ADMIN_USER_ID}'`,
    `export PARITY_ADMIN_USER_EMAIL='${PARITY_ADMIN_USER_EMAIL}'`,
    `export PARITY_TARGET_USER_ID='${PARITY_TARGET_USER_ID}'`,
    `export PARITY_TARGET_USER_EMAIL='${PARITY_TARGET_USER_EMAIL}'`,
    '',
  ].join('\n'))
}
