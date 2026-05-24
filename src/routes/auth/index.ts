import { Elysia } from "elysia"

import { sessionsRoute } from "./sessions"
import { googleOAuthRoute } from "./google"
import { githubRoute } from "./github"
import { adminRoute } from "./admin"
import { emailRoute } from "./email"
import { deviceRoute } from "./device"

export { initOAuthKV } from "./stores"

export const authRoute = new Elysia({ prefix: "/auth" })
  .use(sessionsRoute)
  .use(googleOAuthRoute)
  .use(githubRoute)
  .use(adminRoute)
  .use(emailRoute)
  .use(deviceRoute)
