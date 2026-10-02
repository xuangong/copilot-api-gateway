import { spawn, execFileSync } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { join } from "node:path"

export async function deadline<T>(stage: string, ms: number, action: () => Promise<T>): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("Invalid finite deadline")
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${stage} timed out after ${ms}ms`)), ms)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const groupAlive = (pid: number) => {
  try { process.kill(-pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    if ((error as NodeJS.ErrnoException).code === "EPERM" && process.platform === "darwin") {
      // Darwin can transiently report EPERM for an empty orphaned group.
      // Corroborate absence from the physical process table; do not waive live members.
      const rows = execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8", timeout: 2000 })
      return rows.split("\n").some(row => Number(row.trim().split(/\s+/)[1]) === pid)
    }
    throw error
  }
}
export interface Supervision { pid: number; exitCode: number | null; signal: string | null; timedOut: boolean; interrupted: boolean; cleanupComplete: boolean; actions: string[] }
/** Only the detached child PID returned by spawn is ever used as a PGID. */
export async function supervise(options: { command: string; args: string[]; directory: string; timeoutMs: number; graceMs?: number; signal?: AbortSignal }): Promise<Supervision> {
  const grace = options.graceMs ?? 1500
  if (options.timeoutMs <= 0 || !Number.isFinite(options.timeoutMs) || grace <= 0 || !Number.isFinite(grace)) throw new Error("Invalid child deadline")
  const out = openSync(join(options.directory, "stdout.log"), "wx", 0o600)
  const err = openSync(join(options.directory, "stderr.log"), "wx", 0o600)
  const child = spawn(options.command, options.args, { detached: true, stdio: ["ignore", out, err] })
  closeSync(out); closeSync(err)
  const pid = child.pid
  if (!pid) throw new Error("Owned child failed to spawn")
  let finished = false
  let exitCode: number | null = null
  let signal: string | null = null
  let spawnError: Error | undefined
  child.once("error", error => { spawnError = error; finished = true })
  child.once("exit", (code, reason) => { exitCode = code; signal = reason; finished = true })
  const ends = Date.now() + options.timeoutMs
  while (!finished && Date.now() < ends && !options.signal?.aborted) await sleep(10)
  const timedOut = !finished && Date.now() >= ends
  const interrupted = options.signal?.aborted ?? false
  const actions: string[] = []
  const stop = (reason: NodeJS.Signals) => {
    if (groupAlive(pid)) {
      try { process.kill(-pid, reason); actions.push(reason) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
  }
  if (groupAlive(pid)) {
    stop("SIGTERM")
    const end = Date.now() + grace
    while (groupAlive(pid) && Date.now() < end) await sleep(10)
    if (groupAlive(pid)) stop("SIGKILL")
  }
  const end = Date.now() + grace
  while ((!finished || groupAlive(pid)) && Date.now() < end) await sleep(10)
  const cleanupComplete = finished && !groupAlive(pid)
  if (spawnError) throw spawnError
  return { pid, exitCode, signal, timedOut, interrupted, cleanupComplete, actions }
}
