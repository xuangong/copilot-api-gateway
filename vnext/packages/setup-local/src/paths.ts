import { isAbsolute, join, normalize, resolve, parse } from "node:path"
import { lstatSync, realpathSync, accessSync, constants } from "node:fs"
import { fail } from "./contract"
import type { Client, Target } from "./contract"

export const targets: Record<Target, string[]> = {
  "claude-settings": [".claude", "settings.json"],
  "codex-config": [".codex", "config.toml"],
  "codex-token": [".codex", "copilot-gateway-token"],
  "codex-runner": [".codex", "copilot-gateway", "runner.mjs"],
}
export function targetPath(home: string, target: Target): string {
  if (!isAbsolute(home) || !(target in targets)) return fail("path", "Unsupported setup target")
  return join(home, ...targets[target])
}
export const stateDirectory = (home: string, client: Client) => join(home, client === "codex" ? ".codex" : ".claude", "copilot-gateway")
export function assertSafePath(path: string, file = true): void {
  if (!isAbsolute(path)) fail("path", "Setup paths must be absolute")
  const parts = resolve(path).slice(parse(path).root.length).split(/[\\/]/)
  let current = parse(path).root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      return fail("io", "Cannot inspect setup target")
    }
    const last = index === parts.length - 1
    if (stat.isSymbolicLink() || (last && file ? !stat.isFile() : !stat.isDirectory())) fail("path", "Symlinks and unexpected file types are unsupported")
  }
}
export function preflight(home: string, env: Record<string, string | undefined>, bunExecutable: string): { allowedHome: string; bunExecutable: string } {
  if (!isAbsolute(home)) fail("home", "An absolute home directory is required")
  const allowedHome = realpathSync(home)
  for (const [key, expected] of [["CODEX_HOME", join(allowedHome, ".codex")], ["CLAUDE_CONFIG_DIR", join(allowedHome, ".claude")]] as const) {
    const value = env[key]
    if (value && (!isAbsolute(value) || normalize(value) !== normalize(expected) && normalize(value) !== normalize(join(home, key === "CODEX_HOME" ? ".codex" : ".claude")))) fail("custom-home", "Custom CODEX_HOME or CLAUDE_CONFIG_DIR is unsupported; lease was not exchanged")
  }
  if (!isAbsolute(bunExecutable)) fail("bun", "Bun must already be installed")
  let executable: string
  try { executable = realpathSync(bunExecutable); accessSync(executable, constants.X_OK) } catch { return fail("bun", "Bun must already be installed") }
  assertSafePath(executable)
  return { allowedHome, bunExecutable: executable }
}
