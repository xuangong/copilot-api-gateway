import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { app } from "../src/app"
import { telemetryClock } from "../src/control-plane/telemetry/common"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const python = Bun.which("python3")
const agentPath = fileURLToPath(new URL("../../../tools/trojan-telemetry/trojan-telemetry.py", import.meta.url))
const owner = "e2e-owner" as UserId
const stamp = "2026-11-16T00:00:00.000Z"
const sourceId = `tls_${"e".repeat(32)}`
const key = `tlm_${"e".repeat(64)}`
const session = "ses_e2e_owner"
const sha224 = (value: string) => createHash("sha224").update(value).digest("hex")
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

const log = (hash: string, target: string, sent: string, recv: string, at: string) =>
  `time="${at}" level=info msg="user ${hash} from 1.2.3.4:5555 tunneling to ${target} closed sent: ${sent} recv: ${recv}"`
const LOG = [
  log(sha224("pw1"), "www.google.com:443", "1.00 MiB", "2.00 MiB", "2026-11-16T10:15:00Z"),
  log(sha224("pw1"), "mail.google.com:443", "1.00 MiB", "1.00 MiB", "2026-11-16T10:20:00Z"),
  log(sha224("pw2"), "example.org:443", "512.00 KiB", "512.00 KiB", "2026-11-16T10:40:00Z"),
  log(sha224("pw1"), "cdn.example.co.uk:443", "1.00 GiB", "4.00 GiB", "2026-11-16T11:30:00Z"),
  log("f".repeat(56), "203.0.113.9:443", "1.00 KiB", "1.00 KiB", "2026-11-16T13:10:00Z"),
].join("\n") + "\n"
const vnstat = JSON.stringify({ vnstatversion: "2.6", jsonversion: "2", interfaces: [{ name: "eth0", traffic: { hour: [10, 11, 12, 13].map((hour, index) => ({
  id: index, date: { year: 2026, month: 11, day: 16 }, time: { hour, minute: 0 }, rx: (index + 1) * 10, tx: (index + 1) * 111 })) } }] })
const FAKE_DOCKER = `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if args[:1] == ["logs"]:
    since, until = args[args.index("--since") + 1], args[args.index("--until") + 1]
    for raw in open(os.environ["FAKE_DOCKER_LOG"]):
        stamp = raw.split('time="', 1)[1].split('"', 1)[0]
        if since <= stamp < until:
            sys.stderr.write(raw)
    sys.exit(0)
sys.exit(1)
`

let dir: string
let db: Database
let repo: BunSqliteRepo
let server: ReturnType<typeof Bun.serve>
let closedPort = 0

beforeAll(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  initRuntimeLocation("bun")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  await repo.users.create({ id: owner, name: owner, createdAt: stamp, disabled: false })
  await repo.sessions.create({ token: session as SessionToken, userId: owner, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  await repo.telemetry.createSourceWithinLimit({ id: sourceId, ownerId: owner, name: "trojan-vm", keyHash: sha256(key), settings: {}, createdAt: stamp, lastPushAt: null }, 16)
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app.fetch(request) })
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  closedPort = closed.port
  closed.stop(true)
  dir = mkdtempSync(join(tmpdir(), "telemetry-e2e-"))
  mkdirSync(join(dir, "bin"))
  writeFileSync(join(dir, "bin", "docker"), FAKE_DOCKER)
  writeFileSync(join(dir, "bin", "vnstat"), '#!/bin/sh\ncat "$FAKE_VNSTAT_JSON"\n')
  chmodSync(join(dir, "bin", "docker"), 0o755)
  chmodSync(join(dir, "bin", "vnstat"), 0o755)
  writeFileSync(join(dir, "docker.log"), LOG)
  writeFileSync(join(dir, "vnstat.json"), vnstat)
  writeFileSync(join(dir, "config.json"), JSON.stringify({ password: ["pw1", "pw2"] }))
  // The last agent run before the first scheduled hour: the cursor sits at 09:00, so hours 10 to 13 are computed.
  mkdirSync(join(dir, "state"))
  writeFileSync(join(dir, "state", "cursor.json"), JSON.stringify({ cursor: "2026-11-16T09:00:00Z" }))
})
afterAll(() => { server?.stop(true); db?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); telemetryClock.now = () => Date.now(); __resetPlatformForTests() })

const AGENT_KILL_MS = 40_000

async function runAgent(nowIso: string) {
  telemetryClock.now = () => Date.parse(nowIso)
  const child = Bun.spawn([python!, agentPath, "run", "--state-dir", join(dir, "state"), "--env-file", join(dir, "none.env"), "--now", nowIso], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, TZ: "UTC", HOME: dir,
      TELEMETRY_GATEWAY: `http://127.0.0.1:${server.port}`, TELEMETRY_KEY: key, TROJAN_CONFIG: join(dir, "config.json"),
      PROBE_HOST: "127.0.0.1", PROBE_PORT: String(closedPort), PROBE_TIMEOUT: "2", GEO_DOWNLOAD: "0",
      FAKE_DOCKER_LOG: join(dir, "docker.log"), FAKE_VNSTAT_JSON: join(dir, "vnstat.json"),
    },
    stdout: "pipe", stderr: "pipe",
  })
  // A hung agent must fail with what it printed, not as an opaque test timeout.
  const started = Date.now()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, AGENT_KILL_MS)
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  if (timedOut) {
    throw new Error(`the agent was killed after ${Date.now() - started} ms (limit ${AGENT_KILL_MS} ms) at ${nowIso}\nstderr:\n${err}\nstdout:\n${out}`)
  }
  return { code, out, err }
}

const get = async (path: string) => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/telemetry/sources/${sourceId}${path}`, { headers: { authorization: `Bearer ${session}` } })
  expect(response.status).toBe(200)
  return await response.json() as any
}
const window = "from=2026-11-16T10:00:00Z&to=2026-11-16T14:00:00Z"

test.skipIf(!python)("the real agent pushes computed hours and the gateway reports the expected numbers", async () => {
  await repo.telemetry.updateSource(sourceId, owner, { settings: { checkMetrics: ["probe.ok"], flagNonZeroMetrics: ["probe.fail"] } })
  const first = await runAgent("2026-11-16T14:05:00Z")
  expect(first.code, first.err).toBe(0)

  const metrics = (await get("/metrics")).metrics.map((m: { metric: string }) => m.metric)
  expect(metrics).toEqual(["nic.rx_bytes", "nic.total_bytes", "nic.tx_bytes", "probe.fail", "probe.ok", "proxy.client_bytes", "proxy.client_connections", "proxy.client_match_rate", "proxy.connections", "proxy.recv_bytes", "proxy.sent_bytes", "proxy.total_bytes"])

  // No nginx records in this fixture, so every tunnel is unattributed; the gateway accepts the three-dimension client points and the 0 match rate.
  const byClient = await get(`/top?metric=proxy.client_bytes&groupBy=client&${window}`)
  expect(byClient.rows.map((r: { key: string }) => r.key)).toEqual(["(unmatched)"])
  expect(byClient.total).toBeGreaterThan(0)

  const byDomain = await get(`/series?metric=proxy.sent_bytes&groupBy=domain&top=10&${window}`)
  const values = (key: string) => byDomain.groups.find((g: { key: string }) => g.key === key)?.values
  expect(values("google.com")).toEqual([2 * 1024 ** 2, 0, 0, 0])
  expect(values("example.org")).toEqual([512 * 1024, 0, 0, 0])
  expect(values("example.co.uk")).toEqual([0, 1024 ** 3, 0, 0])
  expect(values("203.0.113.9")).toEqual([0, 0, 0, 1024])
  expect(byDomain.groups.map((g: { key: string }) => g.key)).not.toContain("(other)")
  expect(byDomain.total).toEqual([2 * 1024 ** 2 + 512 * 1024, 1024 ** 3, 0, 1024])

  const byUser = await get(`/top?metric=proxy.sent_bytes&groupBy=user&${window}`)
  expect(byUser.rows.map((r: { key: string; value: number }) => [r.key, r.value])).toEqual([["#1", 2 * 1024 ** 2 + 1024 ** 3], ["#2", 512 * 1024], ["#?", 1024]])
  expect(byUser.total).toBe(2 * 1024 ** 2 + 1024 ** 3 + 512 * 1024 + 1024)
  expect(byUser.otherCurrent).toBe(0)

  const proxyBoth = await get(`/series?metric=proxy.total_bytes&${window}`)
  const up = await get(`/series?metric=proxy.recv_bytes&${window}`)
  expect(proxyBoth.total).toEqual(byDomain.total.map((down: number, index: number) => down + up.total[index]))
  const connections = await get(`/top?metric=proxy.connections&groupBy=domain&${window}`)
  expect(connections.rows.find((r: { key: string }) => r.key === "google.com").value).toBe(2)

  const nic = await get(`/series?metric=nic.tx_bytes&${window}`)
  expect(nic.total).toEqual([111, 222, 333, 444])
  const both = await get(`/series?metric=nic.total_bytes&${window}`)
  const rx = await get(`/series?metric=nic.rx_bytes&${window}`)
  expect(both.total).toEqual(nic.total.map((tx: number, index: number) => tx + rx.total[index]))

  const summary = await get("/summary")
  expect(summary.freshness).toMatchObject({ lastPushAt: "2026-11-16T14:05:00.000Z", stale: false })
  // The probe could not connect (nothing listens on its port): a failed check at the current hour, with its stage.
  expect(summary.flags).toEqual([{ metric: "probe.fail", hour: "2026-11-16T14:00:00Z", total: 1, breakdown: [{ dims: { stage: "tcp" }, value: 1 }] }])
  // The latest closed hour (13:00) precedes the first probe point, so it is not monitored rather than a warning.
  expect(summary.checks).toEqual([{ metric: "probe.ok", hour: "2026-11-16T13:00:00Z", status: "not monitored", stage: null }])
}, 60_000)

// This test depends on the first one: it continues from the cursor, outbox and gateway state that test left behind.
test.skipIf(!python)("a later run only adds the new hour, re-running is idempotent and the failed check shows its stage", async () => {
  const second = await runAgent("2026-11-16T15:05:00Z")
  expect(second.code, second.err).toBe(0)
  const before = await get(`/series?metric=proxy.sent_bytes&groupBy=domain&top=10&${window}`)
  const third = await runAgent("2026-11-16T15:05:00Z")
  expect(third.code, third.err).toBe(0)
  expect(await get(`/series?metric=proxy.sent_bytes&groupBy=domain&top=10&${window}`)).toEqual(before)
  const checks = await get(`/series?metric=probe.ok&from=2026-11-16T13:00:00Z&to=2026-11-16T16:00:00Z`)
  expect(checks.statuses).toEqual(["not monitored", "failed", "failed"])
  expect(checks.stages).toEqual([null, "tcp", "tcp"])
  const summary = await get("/summary")
  expect(summary.checks).toEqual([{ metric: "probe.ok", hour: "2026-11-16T14:00:00Z", status: "failed", stage: "tcp" }])
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_points WHERE metric = 'probe.ok'").get()?.n).toBe(2)
}, 60_000)
