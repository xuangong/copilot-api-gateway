#!/usr/bin/env bun
// Build the React dashboard into a single JS + CSS bundle that the gateway
// inlines into the /dashboard HTML response. Mirrors the main repo's
// scripts/build-dashboard.ts; outputs land alongside the source-of-truth
// `page.ts` so its `./dist/dashboard.{js,css}.txt` imports just work.
import { $ } from "bun"

const root = `${import.meta.dir}/..`
const src = `${root}/apps/dashboard/src`
const out = `${root}/packages/gateway/src/shared/edge/ui-pages/dashboard-app/dist`

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

// The content glob is passed absolute: tailwind resolves a relative one against
// the caller's cwd, and a glob that matches nothing yields a preflight-only
// stylesheet with every utility purged — a silent, ship-shaped failure. It is
// interpolated as a single value so Bun's shell hands it to tailwind intact
// rather than expanding it itself.
const contentGlob = `${src}/**/*.{ts,tsx}`
await $`bunx tailwindcss -c ${root}/tailwind.config.ts --content ${contentGlob} -i ${src}/styles.css -o ${out}/dashboard.css --minify`.quiet()
const css = await Bun.file(`${out}/dashboard.css`).text()
if (css.length < 30_000) throw new Error(`dashboard.css is ${css.length} bytes — the content scan matched nothing`)
await Bun.write(`${out}/dashboard.css.txt`, css)

console.log("[build-dashboard] wrote", `${out}/dashboard.js`, "and dashboard.css")
