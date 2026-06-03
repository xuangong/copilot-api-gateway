// Local Bun runtime entry. D1 / KV / IMAGES bindings are not available outside CFW;
// run via `wrangler dev` for full bindings. This entry exists for non-bound smoke tests.
import { app } from './src/app.ts'

const port = Number(process.env.PORT ?? 8788)

Bun.serve({
  port,
  fetch: (req) => app.fetch(req, {} as never),
})

// eslint-disable-next-line no-console
console.log(`vnext gateway (bun) listening on http://localhost:${port}`)
