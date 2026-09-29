import { Hono } from "hono"
import runnerModule from "./dist/runner.mjs.txt"
import checksumModule from "./dist/runner.sha256.txt"
import shellModule from "./dist/setup.sh.txt"
import powershellModule from "./dist/setup.ps1.txt"
export const setupStaticRouter = new Hono()
const assets: Record<string, { body: string; type: string }> = {
  "runner.mjs": { body: runnerModule as unknown as string, type: "text/javascript" },
  "runner.sha256": { body: checksumModule as unknown as string, type: "text/plain" },
  "setup.sh": { body: shellModule as unknown as string, type: "text/x-shellscript" },
  "setup.ps1": { body: powershellModule as unknown as string, type: "text/plain" },
}
setupStaticRouter.get("/setup/:asset", c => {
  const name = c.req.param("asset")
  const asset = Object.hasOwn(assets, name) ? assets[name] : undefined
  if (!asset || new URL(c.req.url).search) return c.text("Not found", 404)
  return new Response(asset.body, { headers: { "Content-Type": asset.type + "; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } })
})
