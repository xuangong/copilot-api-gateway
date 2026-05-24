/**
 * Admin control-plane endpoints not yet covered by the main route surface.
 *
 *   GET  /api/upstream-flags            — flag catalog (id, label, description, defaults per kind)
 *   POST /api/upstream-probe            — connectivity probe for an inline provider config
 *
 * The probe accepts a provider kind + inline config (the same shape the
 * dashboard would persist) and reports whether the provider can answer a
 * lightweight call. Admin-only because configs include secrets.
 */

import { Elysia } from "elysia"

import { getFlagCatalog, defaultsForUpstream } from "~/flags"
import type { UpstreamKind } from "~/protocols/common"
import { AzureProvider, type AzureProviderConfig } from "~/providers/azure/provider"
import { CustomProvider, type CustomProviderConfig } from "~/providers/custom/provider"

interface AuthCtx {
  isAdmin?: boolean
}

const KINDS: readonly UpstreamKind[] = ["copilot", "custom", "azure"]

interface ProbeBody {
  kind?: string
  config?: Record<string, unknown>
}

function adminGuard(ctx: unknown): Response | null {
  const { isAdmin } = ctx as AuthCtx
  if (!isAdmin) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
  }
  return null
}

async function probeCustom(cfg: CustomProviderConfig): Promise<{ ok: boolean; error?: string }> {
  const provider = new CustomProvider(cfg)
  try {
    await provider.getModels()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function probeAzure(cfg: AzureProviderConfig): Promise<{ ok: boolean; error?: string }> {
  const provider = new AzureProvider(cfg)
  // Azure deployments don't expose a stable model-listing endpoint; the
  // provider returns a synthetic single-entry list. To make the probe
  // meaningful we hit the first declared endpoint with an empty body and
  // accept any non-network error response (the upstream's complaint about
  // the payload still proves connectivity + auth).
  const endpoint = provider.endpoints[0]
  if (!endpoint) return { ok: false, error: "no endpoints declared" }
  try {
    if (endpoint === "chat_completions") await provider.callChatCompletions({ messages: [] })
    else if (endpoint === "responses") await provider.callResponses({ input: [] })
    else if (endpoint === "messages") await provider.callMessages({ messages: [] })
    else if (endpoint === "embeddings") await provider.callEmbeddings({ input: "" })
    else await provider.callMessagesCountTokens({ messages: [] })
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 4xx from upstream proves connectivity; only network/auth errors are failures.
    if (/\b(4\d\d)\b/.test(msg) && !/401|403/.test(msg)) return { ok: true }
    return { ok: false, error: msg }
  }
}

export const controlPlaneRoute = new Elysia()
  .get("/api/upstream-flags", (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const catalog = getFlagCatalog().map((f) => ({
      id: f.id,
      label: f.label,
      description: f.description,
      defaultFor: f.defaultFor,
    }))
    const defaults: Record<string, string[]> = {}
    for (const k of KINDS) defaults[k] = [...defaultsForUpstream(k)]
    return { catalog, defaults }
  })
  .post("/api/upstream-probe", async (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const body = (ctx.body ?? {}) as ProbeBody
    const kind = body.kind
    const config = body.config
    if (typeof kind !== "string" || !config) {
      return new Response(JSON.stringify({ error: "kind and config required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (kind === "custom") return probeCustom(config as unknown as CustomProviderConfig)
    if (kind === "azure") return probeAzure(config as unknown as AzureProviderConfig)
    if (kind === "copilot") {
      return new Response(
        JSON.stringify({ error: "Copilot probe uses /api/copilot-quota — not handled here" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }
    return new Response(JSON.stringify({ error: `Unknown kind: ${kind}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  })
