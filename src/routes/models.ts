import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { getModels } from "~/services/copilot"

interface RouteContext {
  state: AppState | null
}

export const modelsRoute = new Elysia()
  // Dashboard endpoint - gracefully handle no GitHub connection
  .get("/api/models", async (ctx) => {
    const { state } = ctx as unknown as RouteContext
    if (!state?.copilotToken) {
      // Return empty models list when not connected
      return { object: "list", data: [] }
    }
    return getModels(state.copilotToken, state.accountType)
  })
  .get("/models", async (ctx) => {
    const { state } = ctx as unknown as RouteContext
    if (!state?.copilotToken) {
      throw new Error("GitHub token not found. Use /auth/github to connect your account.")
    }
    return getModels(state.copilotToken, state.accountType)
  })
  .get("/v1/models", async (ctx) => {
    const { state } = ctx as unknown as RouteContext
    if (!state?.copilotToken) {
      throw new Error("GitHub token not found. Use /auth/github to connect your account.")
    }
    return getModels(state.copilotToken, state.accountType)
  })
