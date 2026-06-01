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

await $`bunx tailwindcss -c ${root}/tailwind.config.ts -i ${src}/styles.css -o ${out}/dashboard.css --minify`.quiet()

console.log("[build-dashboard] wrote", `${out}/dashboard.js`, "and dashboard.css")
