import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import type { FileGetResult, FileProvider } from "@vibe-core/platform"
import { app } from "../src/app.ts"
import { initRepo } from "../src/repo/index.ts"
import { FileDumpStore } from "../src/repo/dump-store.ts"
import { UpstreamExchangeCollector } from "../src/shared/dump/upstream-attempts.ts"
import { initDumpStore, resetDumpRegistryForTests } from "../src/shared/dump/registry.ts"
import { isDevAuthEnabled } from "../src/control-plane/auth/dev-auth.ts"
import type { ApiKey, User, UserSession } from "../src/repo/types.ts"
import type { ApiKeyId, DumpRecordId, SessionToken, UserId } from "../src/repo/branded-ids.ts"
import type { DumpMetadata, DumpWriteRecord } from "../src/shared/dump/types.ts"

class MemoryFiles implements FileProvider {
  private readonly files = new Map<string, Uint8Array>()

  async put(key: string, body: ReadableStream | Uint8Array | string): Promise<void> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body)
      : body instanceof Uint8Array ? body
      : new Uint8Array(await new Response(body).arrayBuffer())
    this.files.set(key, bytes)
  }

  async get(key: string): Promise<FileGetResult | null> {
    const bytes = this.files.get(key)
    return bytes ? { body: new Blob([bytes as BlobPart]).stream(), size: bytes.byteLength } : null
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key)
  }

  clear(): void {
    this.files.clear()
  }
}

const now = () => new Date().toISOString()

// Synthetic IDs enter the typed repo at this test fixture boundary.
const userId = (value: string): UserId => value as UserId
const apiKeyId = (value: string): ApiKeyId => value as ApiKeyId
const sessionToken = (value: string): SessionToken => value as SessionToken
const dumpRecordId = (value: string): DumpRecordId => value as DumpRecordId

test("dump readers require an explicit owner or admin identity through app.fetch and SQLite", async () => {
  expect(isDevAuthEnabled()).toBe(false)
  const db = new Database(":memory:")
  try {
    const repo = new BunSqliteRepo(db)
    initRepo(repo)
    const files = new MemoryFiles()
    const store = new FileDumpStore(new BunSqliteDatabase(db), files)
    resetDumpRegistryForTests()
    initDumpStore(store)

    for (const [id, email] of [
      ["dump_owner", "owner@example.invalid"],
      ["dump_assignee", "assignee@example.invalid"],
      ["dump_other", "other@example.invalid"],
      ["dump_admin", "test@local.dev"],
    ]) {
      const user: User = { id: userId(id), name: id, email, createdAt: now(), disabled: false }
      const session: UserSession = {
        token: sessionToken(`ses_${id}`), userId: user.id, createdAt: now(), authenticatedAt: Date.now(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }
      await repo.users.create(user)
      await repo.sessions.create(session)
    }

    for (const [id, ownerId, retention] of [
      ["dump_owned", "dump_owner", 3600],
      ["dump_ownerless", undefined, 3600],
      ["dump_disabled", "dump_owner", null],
    ] as const) {
      const key: ApiKey = {
        id: apiKeyId(id), name: id, key: `raw_${id}`, createdAt: now(),
        ownerId: ownerId === undefined ? undefined : userId(ownerId),
        modelMappingsEnabled: false, modelMappings: [], dumpRetentionSeconds: retention,
      }
      await repo.apiKeys.save(key)
    }
    await repo.keyAssignments.assign(apiKeyId("dump_owned"), userId("dump_assignee"), userId("dump_owner"))

    const t = Date.now()
    const put = async (keyId: string, id: string, completedAt: number, withCapture = false) => {
      const meta: DumpMetadata = {
        id: dumpRecordId(id), startedAt: completedAt - 5, completedAt, method: "POST",
        path: "/v1/responses", status: 200, upstream: null, model: null,
        inputTokens: null, outputTokens: null, requestBytes: 0, responseBytes: 0,
        durationMs: 5, error: null,
      }
      const record: DumpWriteRecord = {
        meta,
        request: {
          method: "POST", path: "/v1/responses", headers: [],
          body: await store.prepareRequestBody(new Uint8Array()),
        },
        response: { status: 200, headers: [], body: { type: "none" } },
      }
      if (withCapture) {
        const collector = new UpstreamExchangeCollector(completedAt - 5)
        const attempt = collector.begin({
          parentCallId: "call-1", upstreamId: "upstream-1", method: "POST", operation: "responses.create",
          url: "https://token@secret.invalid/path?credential=secret",
          requestHeaders: [["Authorization", "Bearer secret"], ["X-Account-Credential", "secret"]],
        })
        attempt?.observePreparedRequest({ prefix: Uint8Array.of(0xff, 0xfe), totalBytes: 2 })
        attempt?.observeResponse(204, [], null)
        record.upstreamExchanges = collector.finish(completedAt)
      }
      await store.put(apiKeyId(keyId), record)
    }
    await put("dump_owned", "01H0000000000000000000AAAA", t, true)
    await put("dump_owned", "01H0000000000000000000AAAB", t)
    await put("dump_owned", "01H0000000000000000000OLD0", t - 3_700_000)
    await put("dump_ownerless", "01H0000000000000000000NONE", t)
    await put("dump_disabled", "01H0000000000000000000OFF0", t)

    const request = (path: string, credential?: string, kind: "session" | "apiKey" = "session") => {
      const headers = credential ? kind === "session"
        ? { cookie: `session_token=ses_${credential}` }
        : { authorization: `Bearer ${credential}` } : undefined
      return app.fetch(new Request(`http://local.test${path}`, { headers, signal: AbortSignal.timeout(1000) }))
    }
    const routes = [
      "/api/keys/dump_ownerless/records",
      "/api/keys/dump_ownerless/records/01H0000000000000000000NONE",
      "/api/keys/dump_ownerless/stream",
      "/api/keys/dump_owned/records",
      "/api/keys/dump_owned/records/01H0000000000000000000AAAA",
      "/api/keys/dump_owned/stream",
    ]
    for (const route of routes) {
      expect((await request(route)).status).toBe(403)
      expect((await request(route, "invalid")).status).toBe(403)
    }
    const exportPath = "/api/keys/dump_owned/records/01H0000000000000000000AAAA/export"
    expect((await request(exportPath)).status).toBe(403)
    expect((await request(exportPath, "dump_assignee")).status).toBe(403)
    expect((await request(exportPath, "dump_other")).status).toBe(403)
    const original = await (await request("/api/keys/dump_owned/records/01H0000000000000000000AAAA", "dump_owner")).json()
    expect((original as { upstreamExchanges: { attempts: Array<{ request: { prefixBase64: string } }> } }).upstreamExchanges.attempts[0]?.request.prefixBase64).toBe("//4=")
    expect(JSON.stringify(original)).not.toContain("secret")
    expect((await (await request("/api/keys/dump_owned/records/01H0000000000000000000AAAB", "dump_owner")).json() as { upstreamExchanges: unknown }).upstreamExchanges).toBeNull()
    const exported = await request(exportPath, "dump_owner")
    expect(exported.status).toBe(200)
    expect(exported.headers.get("Cache-Control")).toBe("no-store")
    expect(exported.headers.get("Content-Disposition")).toContain("attachment")
    const exportedBody = await exported.json() as { format: string }
    expect(exportedBody.format).toBe("gateway-dump-redacted-v1")
    expect(JSON.stringify(exportedBody)).not.toContain("//4=")
    expect(JSON.stringify(exportedBody)).not.toContain("upstreamExchanges")
    expect(await (await request("/api/keys/dump_owned/records/01H0000000000000000000AAAA", "dump_owner")).json()).toEqual(original)
    expect((await request(exportPath, "dump_admin")).status).toBe(200)
    expect((await request("/api/keys/dump_ownerless/records/01H0000000000000000000NONE/export", "dump_admin")).status).toBe(200)
    expect((await request("/api/keys/dump_ownerless/records/01H0000000000000000000NONE/export")).status).toBe(403)
    const invalidFilename = await request("/api/keys/dump_owned/records/bad.id/export", "dump_owner")
    expect(invalidFilename.status).toBe(400)
    expect(invalidFilename.headers.get("Content-Disposition")).toBeNull()
    expect((await request("/api/keys/dump_owned/records/01H0000000000000000000NONE/export", "dump_owner")).status).toBe(404)
    expect((await request("/api/keys/dump_disabled/records/01H0000000000000000000OFF0/export", "dump_owner")).status).toBe(404)

    for (const identity of ["dump_assignee", "dump_other"]) {
      expect((await request("/api/keys/dump_owned/records", identity)).status).toBe(403)
      expect((await request("/api/keys/dump_owned/records/01H0000000000000000000AAAA", identity)).status).toBe(403)
    }
    expect((await request("/api/keys/dump_ownerless/records", "dump_owner")).status).toBe(403)
    expect((await request("/api/keys/dump_ownerless/records", "raw_dump_ownerless", "apiKey")).status).toBe(403)
    expect((await request("/api/keys/dump_owned/records", "raw_dump_ownerless", "apiKey")).status).toBe(403)

    const owned = await request("/api/keys/dump_owned/records", "dump_owner")
    expect(owned.status).toBe(200)
    expect((await owned.json() as { records: DumpMetadata[] }).records.map((record) => record.id))
      .toEqual(["01H0000000000000000000AAAB", "01H0000000000000000000AAAA"])
    expect((await request("/api/keys/dump_owned/records/01H0000000000000000000AAAA", "dump_owner")).status).toBe(200)
    expect((await request("/api/keys/dump_owned/records", "raw_dump_owned", "apiKey")).status).toBe(200)
    expect((await request("/api/keys/dump_owned/records/01H0000000000000000000AAAA", "raw_dump_owned", "apiKey")).status).toBe(200)
    expect((await request("/api/keys/dump_ownerless/records", "dump_admin")).status).toBe(200)
    expect((await request("/api/keys/dump_ownerless/records/01H0000000000000000000NONE", "dump_admin")).status).toBe(200)

    const page = await request("/api/keys/dump_owned/records?limit=1&before=01H0000000000000000000AAAB", "dump_owner")
    expect((await page.json() as { records: DumpMetadata[] }).records.map((record) => record.id))
      .toEqual(["01H0000000000000000000AAAA"])
    const otherKeyCursor = await request("/api/keys/dump_owned/records?before=01H0000000000000000000NONE", "dump_owner")
    expect((await otherKeyCursor.json() as { records: DumpMetadata[] }).records).toEqual([])
    expect((await request("/api/keys/dump_owned/records/01H0000000000000000000NONE", "dump_owner")).status).toBe(404)
    expect((await request("/api/keys/dump_owned/records/01H0000000000000000000OLD0", "dump_owner")).status).toBe(404)
    expect((await request("/api/keys/dump_disabled/records", "dump_owner")).status).toBe(404)
    expect((await request("/api/keys/dump_disabled/records/01H0000000000000000000OFF0", "dump_owner")).status).toBe(404)
    const missingId = dumpRecordId("01H0000000000000000000MISS")
    await store.put(apiKeyId("dump_owned"), {
      meta: {
        id: missingId, startedAt: t, completedAt: t, method: "POST", path: "/v1/responses",
        status: 200, upstream: null, model: null, inputTokens: null, outputTokens: null,
        requestBytes: 6, responseBytes: 0, durationMs: 0, error: null,
      },
      request: {
        method: "POST", path: "/v1/responses", headers: [],
        body: await store.prepareRequestBody(new TextEncoder().encode("secret")),
      },
      response: { status: 200, headers: [], body: { type: "none" } },
    })
    files.clear()
    for (const suffix of ["", "/export"]) {
      const response = await request(`/api/keys/dump_owned/records/${missingId}${suffix}`, "dump_owner")
      expect(response.status).toBe(409)
      const body = await response.text()
      expect(body).toContain("Captured body is no longer available")
      expect(body).not.toContain("dumps/v1/")
    }
  } finally {
    db.close()
    resetDumpRegistryForTests()
  }
})
