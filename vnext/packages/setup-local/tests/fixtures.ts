import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalJson, sha256 } from "../src/contract"
import type { Client, Envelope, Platform } from "../src/contract"
import { planSetup } from "../src/planner"
import { readCurrentFiles } from "../src/executor"
export const credential = "a".repeat(64)
export const runner = new TextEncoder().encode("// Static fixture runner\n")
export function temporaryHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "d10b-fixture-")))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }), env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"), CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude") } }
}
export async function envelope(client: Client = "codex", model?: string, origin = "https://gateway.invalid", platform: Platform = "posix"): Promise<Envelope> {
  const body = { version: 1 as const, client, platform, artifact: client === "codex" ? {
    kind: "codex-config" as const, config: { ...(model === undefined ? {} : { model }), model_provider: "copilot_gateway" as const, model_providers: { copilot_gateway: {
      name: "Copilot Gateway" as const, base_url: origin + "/azure-api.codex/", wire_api: "responses" as const, supports_websockets: false,
    } } }, credential: { kind: "gateway-api-key" as const, value: credential },
  } : { kind: "claude-settings" as const, settings: { env: { ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: credential, ...(model === undefined ? {} : { ANTHROPIC_MODEL: model }) } } } }
  return { ...body, artifactDigest: await sha256(canonicalJson(body)) }
}
export async function plan(home: string, client: Client = "codex", model?: string) {
  return planSetup({ artifact: await envelope(client, model), currentFiles: readCurrentFiles(home, client), installation: { allowedHome: home, bunExecutable: realpathSync(process.execPath), runnerBytes: runner } })
}
