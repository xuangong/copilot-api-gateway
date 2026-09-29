import { isAbsolute, basename } from "node:path"
import { canonicalJson, fail, record } from "./contract"
import type { CodexArtifact } from "./contract"
export interface CommandAuth { command: string; args: string[] }
export function tomlString(value: string): string {
  return '"' + Array.from(value, char => {
    const code = char.codePointAt(0)
    if (char === '"' || char === "\\") return "\\" + char
    if (code !== undefined && (code < 32 || code === 127)) return "\\u" + code.toString(16).padStart(4, "0")
    return char
  }).join("") + '"'
}
function literal(value: unknown): string {
  if (typeof value === "string") return tomlString(value)
  if (typeof value === "boolean") return String(value)
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return "[" + value.map(tomlString).join(", ") + "]"
  return fail("toml", "Unsupported managed TOML value")
}
function parseToml(text: string): Record<string, unknown> {
  try { return Bun.TOML.parse(text) as Record<string, unknown> } catch { return fail("toml", "Invalid Codex TOML; resolve it manually") }
}
function withoutManaged(value: Record<string, unknown>, ownModel: boolean): Record<string, unknown> {
  const result = structuredClone(value)
  if (ownModel) delete result.model
  delete result.model_provider
  const providers = result.model_providers as Record<string, unknown> | undefined
  const provider = providers?.copilot_gateway as Record<string, unknown> | undefined
  if (provider) {
    for (const key of ["name", "base_url", "wire_api", "supports_websockets", "auth"]) delete provider[key]
    if (!Object.keys(provider).length) delete providers?.copilot_gateway
  }
  if (providers && !Object.keys(providers).length) delete result.model_providers
  return result
}
export function editToml(current: string | null, artifact: CodexArtifact, auth: CommandAuth): string {
  const text = current ?? ""
  const parsed = parseToml(text)
  const providers = parsed.model_providers === undefined ? {} : record(parsed.model_providers)
  const existing = providers.copilot_gateway === undefined ? {} : record(providers.copilot_gateway)
  if ("env_key" in existing || "requires_openai_auth" in existing) fail("auth-conflict", "Resolve existing copilot_gateway env_key/requires_openai_auth manually")
  if (existing.auth !== undefined) {
    const old = record(existing.auth)
    if (Object.keys(old).sort().join(",") !== "args,command" || typeof old.command !== "string" || !isAbsolute(old.command) || !["bun", "bun.exe"].includes(basename(old.command)) || canonicalJson(old.args) !== canonicalJson(auth.args)) fail("auth-conflict", "Resolve conflicting copilot_gateway auth manually")
  }
  // This deliberately narrow editor rejects legal but ambiguous spans instead
  // of reformatting unrelated comments/tables or guessing their ownership.
  if (text.includes('"""') || text.includes("'''")) fail("toml-ambiguous", "Multiline TOML spans require manual resolution")
  const sections = new Map<string, { start: number; end: number; keys: Map<string, number> }>()
  const lines = text.split(/(?<=\n)/)
  if (lines.length === 1 && lines[0] === "") lines.pop()
  let name = ""
  let section = { start: 0, end: lines.length, keys: new Map<string, number>() }
  sections.set(name, section)
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (trimmed.startsWith("[")) {
      const match = /^\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]\s*(?:#.*)?$/.exec(trimmed)
      if (!match?.[1] || sections.has(match[1])) fail("toml-ambiguous", "Quoted, duplicate, or array TOML tables require manual resolution")
      section.end = index
      name = match[1]
      section = { start: index + 1, end: lines.length, keys: new Map() }
      sections.set(name, section)
    } else {
      const match = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed)
      if (!match?.[1] || section.keys.has(match[1])) fail("toml-ambiguous", "Dotted, quoted, duplicate, or multiline TOML assignments require manual resolution")
      // A complete assignment must parse alone; continuation spans are unsafe.
      parseToml(line)
      section.keys.set(match[1], index)
    }
  }
  if (sections.get("")?.keys.has("model_providers") || sections.get("model_providers")?.keys.has("copilot_gateway") || sections.get("model_providers.copilot_gateway")?.keys.has("auth")) fail("toml-ambiguous", "Inline provider/auth tables require manual resolution")
  const wanted = new Map<string, Record<string, unknown>>([
    ["", { ...(artifact.config.model === undefined ? {} : { model: artifact.config.model }), model_provider: "copilot_gateway" }],
    ["model_providers.copilot_gateway", artifact.config.model_providers.copilot_gateway],
    ["model_providers.copilot_gateway.auth", { ...auth }],
  ])
  const insertions = new Map<number, string[]>()
  let suffix = ""
  for (const [table, values] of wanted) {
    const found = sections.get(table)
    if (!found) {
      suffix += `\n[${table}]\n` + Object.entries(values).map(([key, value]) => `${key} = ${literal(value)}\n`).join("")
      continue
    }
    const missing: string[] = []
    for (const [key, value] of Object.entries(values)) {
      const line = `${key} = ${literal(value)}\n`
      const index = found.keys.get(key)
      if (index === undefined) missing.push(line)
      else lines[index] = line
    }
    let insertion = found.end
    while (insertion > found.start && /^(?:#.*)?$/.test((lines[insertion - 1] ?? "").trim())) insertion--
    insertions.set(insertion, [...(insertions.get(insertion) ?? []), ...missing])
  }
  let output = ""
  for (let index = 0; index <= lines.length; index++) {
    const addition = insertions.get(index)?.join("") ?? ""
    if (addition && output && !output.endsWith("\n")) output += "\n"
    output += addition + (lines[index] ?? "")
  }
  if (suffix && output && !output.endsWith("\n")) output += "\n"
  output += suffix
  const verified = parseToml(output)
  const actualProvider = record(record(verified.model_providers).copilot_gateway)
  for (const [key, value] of Object.entries({ ...artifact.config.model_providers.copilot_gateway, auth })) {
    if (canonicalJson(actualProvider[key]) !== canonicalJson(value)) fail("toml", "Managed TOML verification failed")
  }
  if (verified.model_provider !== "copilot_gateway" || (artifact.config.model !== undefined && verified.model !== artifact.config.model) || canonicalJson(withoutManaged(parsed, artifact.config.model !== undefined)) !== canonicalJson(withoutManaged(verified, artifact.config.model !== undefined))) fail("toml", "Unrelated TOML preservation check failed")
  return output
}
