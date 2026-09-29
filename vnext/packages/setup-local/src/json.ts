import { fail, record } from "./contract"
import type { ClaudeArtifact } from "./contract"
export function editJson(current: string | null, artifact: ClaudeArtifact): string {
  let parsed: Record<string, unknown>
  try { parsed = current === null ? {} : record(JSON.parse(current)) } catch { return fail("json", "Invalid Claude settings JSON; resolve it manually") }
  if (parsed.env !== undefined && (!parsed.env || typeof parsed.env !== "object" || Array.isArray(parsed.env))) fail("json", "Claude env must be an object; resolve it manually")
  return JSON.stringify({ ...parsed, env: { ...parsed.env as Record<string, unknown> | undefined, ...artifact.settings.env },
    ...(artifact.settings.effortLevel === undefined ? {} : { effortLevel: artifact.settings.effortLevel }) }, null, 2) + "\n"
}
