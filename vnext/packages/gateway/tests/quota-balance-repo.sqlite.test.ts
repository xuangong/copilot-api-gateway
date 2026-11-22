import { afterAll, beforeAll } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { quotaBalanceRepoContract } from "./quota-balance-repo-contract"

let db: Database
let repo: BunSqliteRepo
beforeAll(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterAll(() => db.close())

quotaBalanceRepoContract(() => repo.quotaBalance, async (sql, binds = []) => { db.run(sql, binds as never[]) })
