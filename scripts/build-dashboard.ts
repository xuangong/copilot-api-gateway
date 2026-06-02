#!/usr/bin/env bun
// Build the React dashboard into a single JS + CSS bundle that the worker
// inlines into the /dashboard-next HTML response.
import { $ } from "bun"

const root = `${import.meta.dir}/..`
const src = `${root}/src/ui/dashboard-app`
const out = `${src}/dist`

await Bun.build({
  entrypoints: [`${src}/index.tsx`],
  outdir: out,
  target: "browser",
  format: "esm",
  minify: true,
  naming: { entry: "dashboard.js" },
  define: { "process.env.NODE_ENV": '"production"' },
})

// Copy the built JS+CSS alongside .txt twins so wrangler's [[rules]] Text
// matcher can pick them up via plain `import x from "./dist/dashboard.js.txt"`
// (esbuild rejects `with { type: "text" }`). Bun is fine with either path.
await Bun.write(`${out}/dashboard.js.txt`, Bun.file(`${out}/dashboard.js`))

await $`bunx tailwindcss -c ${root}/tailwind.config.ts -i ${src}/styles.css -o ${out}/dashboard.css --minify`.quiet()
await Bun.write(`${out}/dashboard.css.txt`, Bun.file(`${out}/dashboard.css`))

console.log("[build-dashboard] wrote", `${out}/dashboard.js`, "and dashboard.css")
