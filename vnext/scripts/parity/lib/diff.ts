/**
 * Shared diff lib for parity harnesses (12a data-plane, 12b control-plane).
 * Behavior moved verbatim from data-plane-audit.ts; ignore-key set and
 * strong-enum set are now passed in via DiffRules so each harness can
 * supply its own taxonomy.
 */

// ---------- Types ----------

export type GapLabel = 'parity' | 'cosmetic-diff' | 'behavior-gap' | 'route-missing'

export interface DiffEntry {
  layer: 'status' | 'header' | 'body' | 'sse'
  label: GapLabel
  detail: string
}

export interface DiffRules {
  ignoreKeys: ReadonlySet<string>
  headerAllowlist: ReadonlySet<string>
  /** Optional: keys whose VALUES must match strictly (e.g. enums like 'kind'). */
  strongEnumKeys?: ReadonlySet<string>
}

// ---------- Diff: status ----------

export function diffStatus(rootStatus: number, vnextStatus: number): DiffEntry[] {
  if (rootStatus === vnextStatus) return []
  return [{
    layer: 'status',
    label: 'behavior-gap',
    detail: `root=${rootStatus} vnext=${vnextStatus}`,
  }]
}

// ---------- Diff: header (allowlist + value masking) ----------

export function maskHeaderValue(value: string): string {
  return value
    .replace(/;\s*charset=[^;]+/gi, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/:\d{2,5}\b/g, ':<port>')
    .replace(/\b\d+\b/g, '<num>')
}

export function diffHeaders(
  rootHeaders: Record<string, string>,
  vnextHeaders: Record<string, string>,
  rules: DiffRules,
): DiffEntry[] {
  const out: DiffEntry[] = []
  for (const h of rules.headerAllowlist) {
    const r = rootHeaders[h]
    const v = vnextHeaders[h]
    if (r === undefined && v === undefined) continue
    if (r === undefined || v === undefined) {
      out.push({
        layer: 'header',
        label: 'cosmetic-diff',
        detail: `${h}: root=${r ?? '<absent>'} vnext=${v ?? '<absent>'}`,
      })
      continue
    }
    const rm = maskHeaderValue(r)
    const vm = maskHeaderValue(v)
    if (rm !== vm) {
      out.push({
        layer: 'header',
        label: 'cosmetic-diff',
        detail: `${h}: root="${rm}" vnext="${vm}"`,
      })
    }
  }
  return out
}

// ---------- Diff: JSON body ----------

// Strong fields: if present in either side, must match structurally per spec §3.
// For 'choices[].message.content' we only assert "non-empty on both" (string length > 0).
// For 'usage' we compare KEY SETS only (values ignored — token counts wobble).
// These are universal LLM-shape rules, not controlled by DiffRules.
function deepDiff(root: unknown, vnext: unknown, path: string, out: DiffEntry[], rules: DiffRules): void {
  if (root === vnext) return
  if (typeof root !== typeof vnext) {
    out.push({ layer: 'body', label: 'behavior-gap', detail: `${path}: type root=${typeof root} vnext=${typeof vnext}` })
    return
  }
  if (root === null || vnext === null) {
    out.push({ layer: 'body', label: 'behavior-gap', detail: `${path}: root=${root} vnext=${vnext}` })
    return
  }
  if (Array.isArray(root)) {
    if (!Array.isArray(vnext)) {
      out.push({ layer: 'body', label: 'behavior-gap', detail: `${path}: root=array vnext=${typeof vnext}` })
      return
    }
    if (root.length !== vnext.length) {
      out.push({ layer: 'body', label: 'behavior-gap', detail: `${path}: array len root=${root.length} vnext=${vnext.length}` })
      return
    }
    for (let i = 0; i < root.length; i++) deepDiff(root[i], vnext[i], `${path}[${i}]`, out, rules)
    return
  }
  if (typeof root === 'object') {
    const ro = root as Record<string, unknown>
    const vo = vnext as Record<string, unknown>
    const keys = new Set([...Object.keys(ro), ...Object.keys(vo)])
    for (const k of keys) {
      if (rules.ignoreKeys.has(k)) continue
      const sub = `${path}.${k}`

      // strong-enum: value must match exactly (parameterized via rules)
      if (rules.strongEnumKeys?.has(k)) {
        if (ro[k] !== vo[k]) {
          out.push({ layer: 'body', label: 'behavior-gap', detail: `${sub}: enum root=${JSON.stringify(ro[k])} vnext=${JSON.stringify(vo[k])}` })
        }
        continue
      }

      // Strong-field special handling (data-plane parity): non-empty check on content,
      // key-set-only on usage. Kept here so 12a behavior is preserved without
      // re-injection — control-plane simply doesn't pass these key names.
      if (sub.endsWith('.message.content') || sub.endsWith('.content')) {
        const rs = typeof ro[k] === 'string' ? (ro[k] as string).length > 0 : ro[k] != null
        const vs = typeof vo[k] === 'string' ? (vo[k] as string).length > 0 : vo[k] != null
        if (rs !== vs) {
          out.push({ layer: 'body', label: 'behavior-gap', detail: `${sub}: non-empty root=${rs} vnext=${vs}` })
        }
        continue
      }
      if (k === 'usage' || k === 'usageMetadata') {
        const rk = new Set(Object.keys((ro[k] ?? {}) as object))
        const vk = new Set(Object.keys((vo[k] ?? {}) as object))
        const onlyR = [...rk].filter((x) => !vk.has(x))
        const onlyV = [...vk].filter((x) => !rk.has(x))
        if (onlyR.length || onlyV.length) {
          out.push({ layer: 'body', label: 'behavior-gap', detail: `${k} keys: onlyRoot=[${onlyR.join(',')}] onlyVnext=[${onlyV.join(',')}]` })
        }
        continue
      }
      // Gemini countTokens response: top-level `totalTokens` is upstream
      // token-count that wobbles request-to-request like usage. Same for
      // `finishReason` — depends on output length nondeterminism.
      if (k === 'totalTokens' || k === 'finishReason') continue

      deepDiff(ro[k], vo[k], sub, out, rules)
    }
    return
  }
  // primitive mismatch
  out.push({ layer: 'body', label: 'behavior-gap', detail: `${path}: root=${JSON.stringify(root)} vnext=${JSON.stringify(vnext)}` })
}

export function diffJsonBody(rootBody: unknown, vnextBody: unknown, rules: DiffRules): DiffEntry[] {
  const out: DiffEntry[] = []
  deepDiff(rootBody, vnextBody, '$', out, rules)
  return out
}

// ---------- Aggregator ----------

export function aggregateLabel(diffs: DiffEntry[]): GapLabel {
  if (diffs.some((d) => d.label === 'behavior-gap')) return 'behavior-gap'
  if (diffs.some((d) => d.label === 'cosmetic-diff')) return 'cosmetic-diff'
  return 'parity'
}
