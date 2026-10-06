import { fileURLToPath } from "node:url"

const scope = "darwin-process-libproc-rusage-v2"
const probePath = fileURLToPath(new URL("./process-resource-probe.py", import.meta.url))

export interface ProcessResource {
  readonly pid: number
  readonly startIdentity: string
  readonly executableName: string
  readonly userUs: number
  readonly systemUs: number
  readonly rssBytes: number
  /** Host monotonic milliseconds, not epoch time or a Worker isolate clock. */
  readonly observedAtMs: number
  readonly scope: string
}

export interface ProcessResourceDelta {
  readonly pid: number
  readonly startIdentity: string
  readonly scope: string
  readonly elapsedMs: number
  readonly userUs: number
  readonly systemUs: number
  readonly cpuUs: number
}

function validatePid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) {
    throw new Error("PID must be a positive signed 32-bit integer")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function validateResource(value: unknown): asserts value is ProcessResource {
  if (
    !isRecord(value) ||
    typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 || value.pid > 2_147_483_647 ||
    typeof value.startIdentity !== "string" || !/^darwin-abstime:[1-9]\d*$/.test(value.startIdentity) ||
    typeof value.executableName !== "string" || value.executableName.length === 0 ||
    !isCounter(value.userUs) || !isCounter(value.systemUs) || !isCounter(value.rssBytes) ||
    typeof value.observedAtMs !== "number" || !Number.isFinite(value.observedAtMs) || value.observedAtMs < 0 ||
    value.scope !== scope
  ) throw new Error("Invalid Darwin process resource sample")
}

async function runProbe(mode: "sample" | "discover", pid: number): Promise<ProcessResource> {
  validatePid(pid)
  if (process.platform !== "darwin") throw new Error("Process resource probe supports Darwin only")
  const probe = Bun.spawn(["python3", "-I", probePath, mode, String(pid)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output, error, exitCode] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ])
  if (exitCode !== 0) throw new Error(`Process resource probe failed: ${error.trim() || `exit ${exitCode}`}`)
  const value: unknown = JSON.parse(output)
  validateResource(value)
  if (mode === "sample" && value.pid !== pid) throw new Error("Process resource probe returned another PID")
  if (mode === "discover" && value.executableName !== "workerd") throw new Error("Discovered executable is not workerd")
  return value
}

/** Whole-process CPU and instantaneous RSS; excludes child CPU and is not CFW billed CPU. */
export async function readProcessResource(pid: number): Promise<ProcessResource> {
  return runProbe("sample", pid)
}

/** Only searches owner descendants. Zero, multiple, or changing matches fail closed. */
export async function discoverWorkerd(ownerPid: number): Promise<ProcessResource> {
  return runProbe("discover", ownerPid)
}

export function diffProcessResource(before: ProcessResource, after: ProcessResource): ProcessResourceDelta {
  validateResource(before)
  validateResource(after)
  if (
    before.pid !== after.pid || before.startIdentity !== after.startIdentity ||
    before.executableName !== after.executableName || before.scope !== after.scope
  ) throw new Error("Cannot compare resource samples from different process identities or scopes")
  if (after.observedAtMs < before.observedAtMs || after.userUs < before.userUs || after.systemUs < before.systemUs) {
    throw new Error("Process resource timestamps and CPU counters must be monotonic")
  }
  const userUs = after.userUs - before.userUs
  const systemUs = after.systemUs - before.systemUs
  if (!Number.isSafeInteger(userUs + systemUs)) throw new Error("CPU delta exceeds safe integer precision")
  return {
    pid: before.pid,
    startIdentity: before.startIdentity,
    scope: before.scope,
    elapsedMs: after.observedAtMs - before.observedAtMs,
    userUs,
    systemUs,
    cpuUs: userUs + systemUs,
  }
}
