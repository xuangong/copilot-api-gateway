import { Database } from 'bun:sqlite'
import { initEnv } from '@vibe-core/platform'
import { initRepo } from '../../src/repo/index.ts'
import type { SessionToken, UserId } from '../../src/repo/branded-ids.ts'
import { BunSqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { app } from '../../src/app.ts'

// Explicit loopback fixture: never load a user's database or bootstrap a provider.
initEnv(name => process.env[name] ?? '')
const db = new Database(':memory:')
const repo = new BunSqliteRepo(db)
initRepo(repo)
for (const name of ['alice', 'bob']) {
  const id = `agent_remote_${name}` as UserId
  await repo.users.create({ id, name, createdAt: new Date().toISOString(), disabled: false })
  await repo.sessions.create({ token: `ses_agent_remote_${name}` as SessionToken, userId: id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() })
}
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT ?? 0), fetch: request => app.fetch(request) })
const ready = process.env.AGENT_REMOTE_READY_FILE
if (!ready) throw new Error('AGENT_REMOTE_READY_FILE is required for the integration fixture')
await Bun.write(ready, JSON.stringify({ url: server.url.href }))
const close = () => { server.stop(true); db.close(); process.exit(0) }
process.once('SIGTERM', close)
process.once('SIGINT', close)
