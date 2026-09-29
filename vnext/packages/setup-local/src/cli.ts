import { homedir } from "node:os"
import { closeSync, openSync, readFileSync, readSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { fail, originUrl, SetupError, validCredential, validateEnvelope } from "./contract"
import { preflight, targetPath } from "./paths"
import { readPrivate } from "./journal"
import { executeSetup, readCurrentFiles, recoverSetup } from "./executor"
import { planSetup } from "./planner"

export function credentialRead(home: string, path: string): string {
  if (path !== targetPath(home, "codex-token")) fail("credential", "Credential helper failed")
  const bytes = readPrivate(path, 65)
  const value = bytes.toString("utf8").replace(/\n$/, "")
  if (!validCredential(value)) fail("credential", "Credential helper failed")
  return value
}
export async function exchangeSetup(origin: string, lease: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  originUrl(origin)
  if (!/^stl_[0-9a-f]{64}$/.test(lease)) fail("lease", "Invalid one-use setup token")
  let response: Response
  try {
    response = await fetcher(origin + "/api/setup/exchange", { method: "POST", headers: { "X-Setup-Lease": lease }, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" })
  } catch {
    return fail("exchange", "Setup exchange outcome is unknown; revoke this lease and mint a new one in the dashboard")
  }
  if (!response.ok) fail("exchange", "Setup exchange failed; revoke or mint a new lease in the dashboard")
  const reader = response.body?.getReader()
  if (!reader) fail("exchange", "Empty setup response; mint a new lease")
  let text = ""
  let size = 0
  const decoder = new TextDecoder("utf-8", { fatal: true })
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 32_768) { await reader.cancel(); fail("exchange", "Setup response is too large; mint a new lease") }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text) as unknown
  } catch { return fail("exchange", "Invalid setup response; mint a new lease") }
}
function terminalConfirmation(): string {
  let fd: number
  try { fd = openSync(process.platform === "win32" ? "CONIN$" : "/dev/tty", "r") } catch { return fail("confirmation", "Confirmation unavailable; no files written. Mint a new lease to retry") }
  try {
    const byte = Buffer.alloc(1)
    let value = ""
    while (value.length < 32 && readSync(fd, byte, 0, 1, null) > 0) {
      if (byte[0] === 10) break
      value += byte.toString("utf8")
    }
    return value.trim()
  } finally { closeSync(fd) }
}
async function privateInput(): Promise<string[]> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 1024) fail("input", "Setup input exceeds the size limit")
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)
}
export async function runCli(args: string[]): Promise<void> {
  const home = homedir()
  const command = args[0]
  if (command === "credential-read") {
    try {
      if (args.length !== 2 || !args[1]) fail("credential", "Credential helper failed")
      process.stdout.write(credentialRead(realpathSync(home), args[1]) + "\n")
      return
    } catch { return fail("credential", "Credential helper failed") }
  }
  const installation = preflight(home, process.env, process.execPath)
  if (command === "recover" || command === "cleanup") {
    const client = args[1]
    if (args.length !== 2 || (client !== "claude" && client !== "codex")) fail("usage", "Use recover|cleanup claude|codex")
    process.stdout.write(recoverSetup(installation.allowedHome, client, command) + "\n")
    return
  }
  if (command !== "setup" || (args.length !== 5 && !(args.length === 6 && args[5] === "--dry-run")) || args[1] !== "--origin" || args[3] !== "--platform" || !args[2] || !["posix", "windows"].includes(args[4] ?? "")) fail("usage", "Use setup --origin URL --platform posix|windows [--dry-run]; provide token on private stdin")
  const origin = originUrl(args[2])
  const lines = await privateInput()
  const lease = lines[0] ?? ""
  const raw = await exchangeSetup(origin, lease)
  lines[0] = ""
  try {
    const artifact = await validateEnvelope(raw, origin)
    if (artifact.platform !== args[4]) fail("platform", "Lease platform does not match this wrapper")
    const runnerBytes = readFileSync(fileURLToPath(import.meta.url))
    const plan = await planSetup({ artifact, currentFiles: readCurrentFiles(installation.allowedHome, artifact.client), installation: { ...installation, runnerBytes } })
    process.stdout.write(plan.redactedDiff + "\nArtifact SHA-256: " + plan.artifactDigest + "\n")
    if (args[5] === "--dry-run") {
      await executeSetup({ allowedHome: installation.allowedHome, plan, dryRun: true })
      process.stdout.write("Dry run complete; no files written. The lease was consumed.\n")
      return
    }
    process.stderr.write("Type APPLY to write these managed settings (anything else cancels): ")
    const confirmation = lines[1] || terminalConfirmation()
    if (confirmation !== "APPLY") fail("confirmation", "Setup cancelled; no files written")
    const result = await executeSetup({ allowedHome: installation.allowedHome, plan })
    process.stdout.write("Setup complete. Backups and journal retained at " + result.journalPath + ". Run cleanup " + artifact.client + " after inspection.\n")
  } catch (error) {
    if (error instanceof SetupError) throw new SetupError(error.code, error.message + ". The lease was consumed; mint a new lease for another setup")
    return fail("setup", "Local setup failed; inspect retained recovery files and mint a new lease to retry")
  }
}
if (import.meta.main || process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch(error => {
    const message = error instanceof SetupError ? error.message : "Setup failed; inspect the local configuration before retrying"
    process.stderr.write(message + "\n")
    process.exitCode = 1
  })
}
