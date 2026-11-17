import { Hono } from "hono"
import type { Env } from "../../app"
import type { FullAuthCtx } from "../../shared/credential-auth"
import { requireBrowserSessionAllowingQuery } from "../shared/session-guard"
import { telemetryQueriesRouter } from "./queries"
import { telemetrySourcesRouter } from "./sources"

export const telemetryManagementRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()
telemetryManagementRouter.use("*", requireBrowserSessionAllowingQuery)
telemetryManagementRouter.route("/", telemetrySourcesRouter)
telemetryManagementRouter.route("/", telemetryQueriesRouter)
