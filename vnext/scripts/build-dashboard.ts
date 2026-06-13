#!/usr/bin/env bun
// Build the React dashboard into a single JS + CSS bundle that the gateway
// inlines into the /dashboard HTML response. Mirrors the main repo's
// scripts/build-dashboard.ts; outputs land alongside the source-of-truth
// `page.ts` so its `./dist/dashboard.{js,css}.txt` imports just work.
import { $ } from "bun"

const root = `${import.meta.dir}/..`
const src = `${root}/apps/dashboard/src`
const out = `${root}/apps/gateway/src/shared/edge/ui-pages/dashboard-app/dist`

await Bun.build({
  entrypoints: [`${src}/index.tsx`],
  outdir: out,
  target: "browser",
  format: "esm",
  minify: true,
  naming: { entry: "dashboard.js" },
  define: { "process.env.NODE_ENV": '"production"' },
})

await Bun.write(`${out}/dashboard.js.txt`, Bun.file(`${out}/dashboard.js`))

await $`bunx tailwindcss -c ${root}/tailwind.config.ts -i ${src}/styles.css -o ${out}/dashboard.css --minify`.quiet()
await Bun.write(`${out}/dashboard.css.txt`, Bun.file(`${out}/dashboard.css`))

console.log("[build-dashboard] wrote", `${out}/dashboard.js`, "and dashboard.css")
