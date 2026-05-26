import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { listUpstreamModels, type CreateProviderOptions } from "~/providers/registry"

interface RouteContext {
  state: AppState | null
  userId?: string
}

function copilotOptions(state: AppState | null): CreateProviderOptions | undefined {
  if (!state?.copilotToken) return undefined
  return { copilotToken: state.copilotToken, accountType: state.accountType }
}

export const modelsRoute = new Elysia()
  // Dashboard endpoint - gracefully handle no GitHub connection
  .get("/api/models", async (ctx) => {
    const { state, userId } = ctx as unknown as RouteContext
    return listUpstreamModels({ ownerId: userId, copilot: copilotOptions(state) })
  })
  .get("/models", async (ctx) => {
    const { state, userId } = ctx as unknown as RouteContext
    const models = await listUpstreamModels({ ownerId: userId, copilot: copilotOptions(state) })
    if (!models.data.length && !state?.copilotToken) {
      throw new Error("GitHub token not found. Use /auth/github to connect your account.")
    }
    return models
  })
  .get("/v1/models", async (ctx) => {
    const { state, userId } = ctx as unknown as RouteContext
    const models = await listUpstreamModels({ ownerId: userId, copilot: copilotOptions(state) })
    if (!models.data.length && !state?.copilotToken) {
      throw new Error("GitHub token not found. Use /auth/github to connect your account.")
    }
    return models
  })
