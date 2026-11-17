import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { TELEMETRY_AGENT_SHA256, TELEMETRY_AGENT_VERSION, TELEMETRY_INSTALLER_SHA256 } from "../src/control-plane/telemetry/agent-release"

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
const agent = (name: string) => read(`../../../tools/trojan-telemetry/${name}`)
const agentBytes = (name: string) => readFileSync(fileURLToPath(new URL(`../../../tools/trojan-telemetry/${name}`, import.meta.url)))

test("the version the install command pins equals VERSION and the agent's own constant", () => {
  expect(TELEMETRY_AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  expect(agent("VERSION").trim()).toBe(TELEMETRY_AGENT_VERSION)
  expect(/^AGENT_VERSION = "(.+)"$/m.exec(agent("trojan-telemetry.py"))?.[1]).toBe(TELEMETRY_AGENT_VERSION)
})

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

test("the pinned agent hash equals the committed agent, which the release copies unchanged", () => {
  expect(sha256(agentBytes("trojan-telemetry.py"))).toBe(TELEMETRY_AGENT_SHA256)
})

test("the pinned installer hash equals the committed installer with the version stamped as build-release.sh does", () => {
  const placeholder = Buffer.from("__TELEMETRY_VERSION__")
  const source = agentBytes("install.sh")
  const at = source.indexOf(placeholder)
  expect(at).toBeGreaterThan(-1)
  const stamped = Buffer.concat([source.subarray(0, at), Buffer.from(TELEMETRY_AGENT_VERSION), source.subarray(at + placeholder.length)])
  expect(stamped.includes(placeholder)).toBe(false)
  expect(sha256(stamped)).toBe(TELEMETRY_INSTALLER_SHA256)
})

test("the installer carries exactly one version placeholder for build-release.sh to stamp", () => {
  expect(agent("install.sh").match(/__TELEMETRY_VERSION__/g)).toHaveLength(1)
})

test("the release workflow builds on telemetry-agent tags, checks every version source and uses the release builder", () => {
  const path = "../../../../.github/workflows/telemetry-agent-release.yml"
  expect(existsSync(fileURLToPath(new URL(path, import.meta.url)))).toBe(true)
  const workflow = read(path)
  expect(workflow).toContain("telemetry-agent-v*")
  expect(workflow).toContain("TELEMETRY_AGENT_VERSION")
  expect(workflow).toContain("AGENT_VERSION")
  expect(workflow).toContain("tools/trojan-telemetry/VERSION")
  expect(workflow).toContain("build-release.sh")
  expect(workflow).toContain("SHA256SUMS")
})

test("the release workflow limits write access to the job, pins every action to a commit and verifies the pinned hashes before publishing", () => {
  const workflow = read("../../../../.github/workflows/telemetry-agent-release.yml")
  expect(workflow).toMatch(/^permissions: \{\}$/m)
  expect(workflow).not.toMatch(/^permissions:\n {2}contents: write/m)
  expect(workflow).toMatch(/^ {4}permissions:\n {6}contents: write$/m)
  const uses = [...workflow.matchAll(/^\s*uses: (\S+)(.*)$/gm)]
  expect(uses.length).toBeGreaterThan(0)
  for (const [, action, rest] of uses) {
    expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    expect(rest).toMatch(/^ # v\d+/)
  }
  expect(workflow).toContain("TELEMETRY_AGENT_SHA256")
  expect(workflow).toContain("TELEMETRY_INSTALLER_SHA256")
  expect(workflow.indexOf("TELEMETRY_INSTALLER_SHA256")).toBeLessThan(workflow.indexOf("gh release create"))
})

test("CI runs the agent tests", () => {
  expect(read("../../../../.github/workflows/vnext-ci.yml")).toContain("bun run test:agent")
  expect(JSON.parse(read("../../../package.json")).scripts["ci:local"]).toContain("bun run test:agent")
})
