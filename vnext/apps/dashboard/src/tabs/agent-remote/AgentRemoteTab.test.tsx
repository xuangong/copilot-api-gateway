import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { HostCard, ShareRow } from "./AgentRemoteTab"
import { parseSessionLimit } from "../../api/agent-remote"

const host = { id: "host_1", name: "Studio", online: true, providers: [{ providerId: "codex", displayName: "Codex" }], managed: true, access: "shared" as const, sessionQuota: { used: 3, limit: 3 } }

test("a shared Host at its creation limit still links to existing sessions", () => {
  const html = renderToStaticMarkup(<HostCard host={host} />)
  expect(html).toContain('href="/agent-remote?host=host_1"')
  expect(html).toContain("3 / 3")
  expect(html).toContain("Existing sessions remain available")
  expect(html).not.toContain("Manage sharing")
}, 5000)

test("only owners can manage shares and offline status is explicit", () => {
  const html = renderToStaticMarkup(<HostCard host={{ ...host, online: false, access: "owner" }} />)
  expect(html).toContain("Manage sharing")
  expect(html).toContain("Offline")
  expect(html).toContain("Owner")
  expect(html).toContain("Codex")
}, 5000)

test("revoked grants display retained cumulative usage and can be granted again", () => {
  const html = renderToStaticMarkup(<ShareRow share={{ subject: "user", label: "user@example.com", sessionLimit: 5, used: 3, revoked: true }} onSave={async () => {}} onRevoke={async () => {}} busy={false} />)
  expect(html).toContain("3 / 5")
  expect(html).toContain("Revoked")
  expect(html).toContain("Grant again")
  expect(html).not.toContain(">Revoke<")
}, 5000)

test("quota input accepts zero and whole cumulative limits only", () => {
  expect(parseSessionLimit("0")).toBe(0)
  expect(parseSessionLimit("12")).toBe(12)
  for (const value of ["", "-1", "1.5", "1e2", "10001", "9007199254740992"]) expect(parseSessionLimit(value)).toBeUndefined()
}, 5000)
