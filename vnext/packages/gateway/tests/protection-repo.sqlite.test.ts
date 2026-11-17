// packages/gateway/tests/protection-repo.sqlite.test.ts
import { afterAll, beforeAll } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { protectionRepoContract } from "./protection-repo-contract"

let db: Database
let repo: BunSqliteRepo
beforeAll(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterAll(() => db.close())

protectionRepoContract(() => repo.protection, async (sql, binds = []) => { db.run(sql, binds as never[]) })
