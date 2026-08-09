/**
 * Seeds .vnext-local.sqlite with a demo user + two overlapping custom upstreams
 * so the dashboard's per-upstream model list can be exercised without real
 * provider credentials. Wipes users/sessions/upstreams first — point it only at
 * a throwaway local db. Local-only scratch tool; not wired into any script.
 */
import { Database } from "bun:sqlite"

const db = new Database(process.argv[2] ?? "apps/platform-bun/.vnext-local.sqlite")
const now = new Date().toISOString()
const expires = new Date(Date.now() + 30 * 864e5).toISOString()

db.run("delete from user_sessions")
db.run("delete from users")
db.run("delete from upstreams")

db.run(
  "insert into users (id,name,created_at,disabled,email) values (?,?,?,0,?)",
  ["usr_demo", "demo", now, "demo@example.com"],
)
db.run("insert into user_sessions (token,user_id,created_at,expires_at) values (?,?,?,?)", [
  "ses_demo_token",
  "usr_demo",
  now,
  expires,
])

const mk = (id: string, name: string, sortOrder: number, models: string[]) => {
  db.run(
    `insert into upstreams (id,owner_id,provider,name,enabled,sort_order,config_json,flag_overrides,disabled_public_model_ids,created_at,updated_at)
     values (?,?,?,?,1,?,?,'{}','[]',?,?)`,
    [
      id,
      "usr_demo",
      "custom",
      name,
      sortOrder,
      JSON.stringify({
        name,
        baseUrl: "https://stub.invalid/v1",
        apiKey: "sk-stub",
        endpoints: ["chat_completions"],
        models,
      }),
      now,
      now,
    ],
  )
}

// alpha sorts first, so under global dedup beta contributes nothing —
// exactly the production symptom (xuangong / idyllic84 rendering empty).
mk("up_alpha", "alpha", 0, ["shared-a", "shared-b", "alpha-only"])
mk("up_beta", "beta", 1, ["shared-a", "shared-b", "beta-only"])

console.log("seeded:", db.query("select id,name,sort_order from upstreams").all())
