import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import { SqliteRepo } from "../src/repo/sqlite"

describe("upstream repository", () => {
  test("saves, lists, filters, and deletes upstream records", async () => {
    const repo = new SqliteRepo(new Database(":memory:"))
    const now = "2026-05-26T00:00:00.000Z"

    await repo.upstreams.save({
      id: "up_custom_1",
      ownerId: "u1",
      provider: "custom",
      name: "Custom One",
      enabled: true,
      sortOrder: 2,
      config: { baseUrl: "https://api.example.com/v1", apiKey: "k" },
      flagOverrides: { "strip-service-tier": true },
      createdAt: now,
      updatedAt: now,
    })
    await repo.upstreams.save({
      id: "up_azure_1",
      ownerId: "u1",
      provider: "azure",
      name: "Azure One",
      enabled: false,
      sortOrder: 1,
      config: { endpoint: "https://x.openai.azure.com", apiKey: "k" },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })

    expect(await repo.upstreams.list({ ownerId: "u1" })).toEqual([
      expect.objectContaining({ id: "up_custom_1", provider: "custom", enabled: true, sortOrder: 2 }),
    ])
    expect((await repo.upstreams.list({ ownerId: "u1", includeDisabled: true })).map((u) => u.id)).toEqual([
      "up_azure_1",
      "up_custom_1",
    ])

    const saved = await repo.upstreams.getById("up_custom_1")
    expect(saved?.config).toEqual({ baseUrl: "https://api.example.com/v1", apiKey: "k" })
    expect(saved?.flagOverrides).toEqual({ "strip-service-tier": true })

    expect(await repo.upstreams.delete("up_custom_1")).toBe(true)
    expect(await repo.upstreams.getById("up_custom_1")).toBeNull()
  })

  test("migrates pre-existing GitHub accounts when SqliteRepo initializes", async () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE github_accounts (
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'individual',
        login TEXT NOT NULL,
        name TEXT,
        avatar_url TEXT,
        owner_id TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        flag_overrides TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT,
        PRIMARY KEY (user_id, owner_id)
      );
      INSERT INTO github_accounts (user_id, token, account_type, login, name, avatar_url, owner_id, enabled, sort_order, flag_overrides, updated_at)
      VALUES (42, 'gho_x', 'individual', 'alice', 'Alice', 'https://avatar.example/alice', 'owner-1', 1, 5, '{"retry-cyber-policy":true}', '2026-05-26T01:00:00.000Z');
    `)

    const repo = new SqliteRepo(db)
    const upstreams = await repo.upstreams.list({ ownerId: "owner-1", includeDisabled: true })
    expect(upstreams).toHaveLength(1)
    expect(upstreams[0]).toMatchObject({
      id: "up_copilot_owner-1_42",
      provider: "copilot",
      name: "alice",
      enabled: true,
      sortOrder: 5,
      flagOverrides: { "retry-cyber-policy": true },
    })
    expect(upstreams[0].config).toEqual({
      githubToken: "gho_x",
      accountType: "individual",
      user: { id: 42, login: "alice", name: "Alice", avatar_url: "https://avatar.example/alice" },
    })
  })
})
