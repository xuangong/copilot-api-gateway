import { Hono } from "hono"
import type { Env } from "../../app"
import type { FullAuthCtx } from "../../shared/credential-auth"
import { requireBrowserSession } from "../shared/session-guard"
import { syncDevicesRouter } from "./devices"
import { syncSourceRouter } from "./source"

export const syncManagementRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()
syncManagementRouter.use("*", requireBrowserSession)
syncManagementRouter.route("/", syncDevicesRouter)
syncManagementRouter.route("/", syncSourceRouter)
