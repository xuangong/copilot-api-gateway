/**
 * Copilot exposes Claude in multiple raw variants that share one "public" id:
 *   claude-opus-4.7              (base, 200K)
 *   claude-opus-4.7-high         (reasoning_effort=high)
 *   claude-opus-4.7-xhigh        (reasoning_effort=xhigh)
 *   claude-opus-4.7-1m-internal  (1M context window)
 *
 * These suffixes are an internal selection mechanism, not models clients should
 * see. We merge variants into one public id for /models surfacing, and reverse
 * the mapping at request time using the anthropic-beta header and reasoning
 * effort fields.
 *
 * Anthropic also publishes a small set of beta flags; only some are accepted
 * by Copilot upstream. `context-1m-2025-08-07` in particular is *purely* a
 * client signal — Copilot does not understand it and 400s if forwarded.
 */

import type { Model, ModelsResponse } from "./models"

const CLAUDE_VARIANT_SUFFIX = /-(?:high|xhigh|1m(?:-internal)?)$/
const CLAUDE_DATE_SUFFIX = /-\d{8}$/

export const CONTEXT_1M_BETA = "context-1m-2025-08-07"
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"

/** Betas Copilot upstream will accept verbatim. */
const ALLOWED_ANTHROPIC_BETAS = new Set<string>([
  INTERLEAVED_THINKING_BETA,
  CONTEXT_1M_BETA,
  "fine-grained-tool-streaming-2025-05-14",
  "advanced-tool-use-2025-11-20",
])

const isClaudeModel = (id: string): boolean => id.startsWith("claude-")

/**
 * Anthropic's official API uses dash-separated versions (`claude-opus-4-7`)
 * while Copilot's raw model ids use dots (`claude-opus-4.7`). Clients pointed
 * at the official model id would otherwise miss every Copilot variant lookup.
 * Rewrite the trailing `-N-N` (and optional patch) into `-N.N` so downstream
 * id matching and variant resolution all key off the Copilot form.
 */
const ANTHROPIC_DASH_VERSION = /^(claude-[a-z]+)-(\d+)-(\d+)(-.*)?$/
export function normalizeAnthropicVersion(id: string): string {
  if (!isClaudeModel(id)) return id
  const m = ANTHROPIC_DASH_VERSION.exec(id)
  if (!m) return id
  return `${m[1]}-${m[2]}.${m[3]}${m[4] ?? ""}`
}

/** Strip date and variant suffixes so siblings collapse onto one id. */
export function copilotPublicModelId(id: string): string {
  if (!isClaudeModel(id)) return id
  return id.replace(CLAUDE_DATE_SUFFIX, "").replace(CLAUDE_VARIANT_SUFFIX, "")
}

function maxOf(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => typeof v === "number")
  return defined.length > 0 ? Math.max(...defined) : undefined
}

function unionStrings(
  ...lists: Array<readonly string[] | undefined>
): string[] | undefined {
  const seen: string[] = []
  let saw = false
  for (const list of lists) {
    if (!list) continue
    saw = true
    for (const v of list) if (!seen.includes(v)) seen.push(v)
  }
  return saw ? seen : undefined
}

function pickBase(variants: Array<Model>): Model {
  const first = variants[0]!
  const baseId = copilotPublicModelId(first.id)
  const exact = variants.find((m) => m.id === baseId)
  if (exact) return exact
  return [...variants].sort((a, b) => a.id.length - b.id.length)[0]!
}

function mergeVariantGroup(variants: Array<Model>): Model {
  const first = variants[0]!
  if (variants.length === 1 && !isClaudeModel(first.id)) return first
  const base = pickBase(variants)
  const baseId = copilotPublicModelId(base.id)
  const limits = base.capabilities?.limits ?? {}
  const supports = (base.capabilities?.supports ?? {}) as Record<string, unknown>

  return {
    ...base,
    id: baseId,
    version: baseId,
    capabilities: {
      ...base.capabilities,
      limits: {
        ...limits,
        max_context_window_tokens: maxOf(
          ...variants.map((v) => v.capabilities?.limits?.max_context_window_tokens),
        ),
        max_prompt_tokens: maxOf(
          ...variants.map((v) => v.capabilities?.limits?.max_prompt_tokens),
        ),
        max_output_tokens: maxOf(
          ...variants.map((v) => v.capabilities?.limits?.max_output_tokens),
        ),
      },
      supports: {
        ...supports,
        reasoning_effort: unionStrings(
          ...variants.map(
            (v) =>
              (v.capabilities?.supports as { reasoning_effort?: string[] } | undefined)
                ?.reasoning_effort,
          ),
        ),
      } as typeof base.capabilities.supports,
    },
    available_combinations: computeCombinations(variants),
  }
}

function computeCombinations(
  variants: ReadonlyArray<Model>,
): Array<{ context1m: boolean; effort?: string }> | undefined {
  if (variants.length === 0 || !isClaudeModel(variants[0]!.id)) return undefined
  const buckets: Array<{ context1m: boolean; efforts: Set<string | undefined> }> = [
    { context1m: false, efforts: new Set() },
    { context1m: true, efforts: new Set() },
  ]
  for (const model of variants) {
    const supports1m = variantSupports1m(model)
    const efforts = (model.capabilities?.supports as { reasoning_effort?: string[] } | undefined)
      ?.reasoning_effort
    const bucket = buckets[supports1m ? 1 : 0]!
    if (!efforts || efforts.length === 0) bucket.efforts.add(undefined)
    else for (const e of efforts) bucket.efforts.add(e)
  }
  const order = ["low", "medium", "high", "xhigh"]
  const out: Array<{ context1m: boolean; effort?: string }> = []
  for (const bucket of buckets) {
    if (bucket.efforts.size === 0) continue
    const efforts = Array.from(bucket.efforts).sort((a, b) => {
      if (a === undefined) return -1
      if (b === undefined) return 1
      return order.indexOf(a) - order.indexOf(b)
    })
    for (const effort of efforts) out.push({ context1m: bucket.context1m, effort })
  }
  return out
}

/**
 * Collapse Claude variant siblings (`-high/-xhigh/-1m-internal`) into one
 * public model id. Non-Claude entries pass through untouched.
 */
export function mergeClaudeVariants(models: ModelsResponse): ModelsResponse {
  const groups = new Map<string, Array<Model>>()
  const order: Array<string> = []

  for (const model of models.data) {
    const key = isClaudeModel(model.id) ? copilotPublicModelId(model.id) : model.id
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(model)
  }

  return {
    object: models.object,
    data: order.map((key) => mergeVariantGroup(groups.get(key)!)),
  }
}

export function hasContext1mBeta(
  betas: readonly string[] | undefined,
): boolean {
  return betas?.includes(CONTEXT_1M_BETA) === true
}

/** Parse comma-separated anthropic-beta header into a deduplicated list. */
export function parseAnthropicBeta(
  header: string | null | undefined,
): string[] {
  if (!header) return []
  const out: string[] = []
  for (const part of header.split(",")) {
    const trimmed = part.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * Build the anthropic-beta header value forwarded to Copilot. Drops
 * `context-1m-2025-08-07` (client-only signal) and any beta not in our
 * allowlist. Optionally injects `interleaved-thinking-2025-05-14` when the
 * request has thinking.budget_tokens (matching Copilot's expectation).
 */
export function filterAnthropicBetaForUpstream(
  betas: readonly string[] | undefined,
  options: { thinkingBudgetTokens?: boolean; isAdaptiveThinking?: boolean } = {},
): string[] {
  const isAdaptive = options.isAdaptiveThinking === true
  const filtered = (betas ?? []).filter(
    (v) =>
      ALLOWED_ANTHROPIC_BETAS.has(v) &&
      !(isAdaptive && v === INTERLEAVED_THINKING_BETA),
  )
  if (
    options.thinkingBudgetTokens &&
    !isAdaptive &&
    !filtered.includes(INTERLEAVED_THINKING_BETA)
  ) {
    filtered.push(INTERLEAVED_THINKING_BETA)
  }
  return Array.from(new Set(filtered))
}

interface VariantHints {
  context1m?: boolean
  reasoningEffort?: string
}

/**
 * Parse a composite model id like `claude-opus-4.7-xhigh-1m` into its parts.
 * Suffixes recognized: `-high|-xhigh` (effort) and `-1m` (1M context window).
 * Either may appear in any order; both optional.
 *
 * Non-Claude ids pass through with no effort/context flags.
 */
export interface ParsedCompositeModelId {
  baseId: string
  effort?: string
  context1m?: boolean
}

const EFFORT_SUFFIXES = new Set(["high", "xhigh"])

export function parseCompositeModelId(id: string): ParsedCompositeModelId {
  if (!isClaudeModel(id)) return { baseId: id }

  let rest = normalizeAnthropicVersion(id)
  let effort: string | undefined
  let context1m = false

  // Strip up to two known suffixes in any order.
  for (let i = 0; i < 2; i++) {
    const lastDash = rest.lastIndexOf("-")
    if (lastDash < 0) break
    const suffix = rest.slice(lastDash + 1)
    if (suffix === "1m" && !context1m) {
      context1m = true
      rest = rest.slice(0, lastDash)
    } else if (EFFORT_SUFFIXES.has(suffix) && !effort) {
      effort = suffix
      rest = rest.slice(0, lastDash)
    } else {
      break
    }
  }

  return { baseId: copilotPublicModelId(rest), effort, context1m }
}

/**
 * For a Claude base id, enumerate the (context, effort) combinations
 * the upstream actually offers. Used by the dashboard to build a single
 * composite-id picker that mirrors what the gateway will resolve to.
 *
 * Returns combinations sorted: 200K efforts first, then 1M efforts.
 * Always includes at least one entry per available context window even
 * when the variant has no reasoning_effort capability (effort=undefined).
 */
export interface ModelCombination {
  context1m: boolean
  effort?: string
}

export function composeModelOptions(
  rawModels: ModelsResponse,
  baseId: string,
): Array<ModelCombination> {
  if (!isClaudeModel(baseId) || !STANDARD_CLAUDE_BASE_ID.test(baseId)) return []

  const candidates = rawModels.data.filter((m) => isVariantForBase(baseId, m))
  if (candidates.length === 0) return []

  const buckets: Array<{ context1m: boolean; efforts: Set<string | undefined> }> = [
    { context1m: false, efforts: new Set() },
    { context1m: true, efforts: new Set() },
  ]

  for (const model of candidates) {
    const supports1m = variantSupports1m(model)
    const efforts = (model.capabilities?.supports as { reasoning_effort?: string[] } | undefined)
      ?.reasoning_effort
    const bucket = buckets[supports1m ? 1 : 0]!
    if (!efforts || efforts.length === 0) {
      bucket.efforts.add(undefined)
    } else {
      for (const e of efforts) bucket.efforts.add(e)
    }
  }

  const out: Array<ModelCombination> = []
  for (const bucket of buckets) {
    if (bucket.efforts.size === 0) continue
    const efforts = Array.from(bucket.efforts).sort((a, b) => {
      if (a === undefined) return -1
      if (b === undefined) return 1
      const order = ["low", "medium", "high", "xhigh"]
      return order.indexOf(a) - order.indexOf(b)
    })
    for (const effort of efforts) {
      out.push({ context1m: bucket.context1m, effort })
    }
  }
  return out
}

/** Build composite id like `claude-opus-4.7-xhigh-1m` from parts. */
export function buildCompositeModelId(
  baseId: string,
  opts: { effort?: string; context1m?: boolean } = {},
): string {
  let id = baseId
  if (opts.effort && EFFORT_SUFFIXES.has(opts.effort)) id = `${id}-${opts.effort}`
  if (opts.context1m) id = `${id}-1m`
  return id
}

function variantSupports1m(model: Model): boolean {
  if (/-1m(?:-|$)/.test(model.id)) return true
  const limits = model.capabilities?.limits
  const explicit = limits?.max_context_window_tokens
  if (typeof explicit === "number") return explicit >= 1_000_000
  const prompt = limits?.max_prompt_tokens ?? 0
  const output = limits?.max_output_tokens ?? 0
  return prompt + output >= 1_000_000
}

function variantSupportsEffort(model: Model, effort: string | undefined): boolean {
  if (!effort) return true
  const efforts = (model.capabilities?.supports as { reasoning_effort?: string[] } | undefined)
    ?.reasoning_effort
  return efforts?.includes(effort) === true
}

const STANDARD_CLAUDE_BASE_ID = /^claude-[a-z0-9-]+-\d+(?:\.\d+)?$/
const KNOWN_VARIANT_SUFFIXES = new Set(["high", "xhigh", "1m", "1m-internal"])

function variantSuffix(baseId: string, id: string): string | undefined {
  if (id === baseId) return ""
  return id.startsWith(`${baseId}-`) ? id.slice(baseId.length + 1) : undefined
}

function isVariantForBase(baseId: string, model: Model): boolean {
  const suffix = variantSuffix(baseId, model.id)
  return suffix === "" || (suffix !== undefined && KNOWN_VARIANT_SUFFIXES.has(suffix))
}

function preference(a: Model, b: Model): number {
  const ad = a.id.split("-").length
  const bd = b.id.split("-").length
  return ad - bd || a.id.localeCompare(b.id)
}

const firstPreferred = (models: ReadonlyArray<Model>): Model | undefined =>
  [...models].sort(preference)[0]

/**
 * Reverse the merge: given a public-ish model id and the request hints,
 * pick the upstream raw variant id Copilot should be asked to run. Falls back
 * to the input id when no candidates exist (e.g. non-Claude models).
 */
export function resolveCopilotRawModel(
  models: ModelsResponse,
  modelId: string,
  hints: VariantHints = {},
): string {
  if (!isClaudeModel(modelId)) return modelId

  const normalized = copilotPublicModelId(normalizeAnthropicVersion(modelId))
  const exact = models.data.find((m) => m.id === normalized)
  const baseId = STANDARD_CLAUDE_BASE_ID.test(normalized) ? normalized : undefined

  if (!baseId) return exact?.id ?? modelId

  const candidates = models.data.filter((m) => isVariantForBase(baseId, m))
  if (candidates.length === 0) return exact?.id ?? modelId

  const effort = hints.reasoningEffort
  const exactBase = exact && exact.id === baseId ? exact : undefined

  if (!hints.context1m && !effort) {
    return (exactBase ?? firstPreferred(candidates))?.id ?? modelId
  }

  if (hints.context1m) {
    const oneM = candidates.filter(variantSupports1m)
    const oneMEffort = oneM.filter((m) => variantSupportsEffort(m, effort))
    return (
      firstPreferred(oneMEffort) ??
      firstPreferred(oneM) ??
      exactBase ??
      firstPreferred(candidates)
    )?.id ?? modelId
  }

  const withEffort = candidates.filter((m) => variantSupportsEffort(m, effort))
  return (
    firstPreferred(withEffort.filter(variantSupports1m)) ??
    firstPreferred(withEffort) ??
    exactBase ??
    firstPreferred(candidates)
  )?.id ?? modelId
}
