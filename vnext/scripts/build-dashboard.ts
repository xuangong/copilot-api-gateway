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

// Tailwind 4 reads its sources from styles.css (`@source`, relative to the
// stylesheet), so no content glob or config file is passed here.
//
// Which node_modules holds the bin depends on how bun laid the install out:
// isolated installs put it under the dashboard, hoisted ones (as in the Docker
// image) at the workspace root. Either is fine as long as it is the v4 CLI — a
// stale v3 bin left at the root would silently mis-build a v4 stylesheet, so
// the version is checked rather than trusted.
const tailwindCandidates = [`${root}/apps/dashboard/node_modules/.bin/tailwindcss`, `${root}/node_modules/.bin/tailwindcss`]
let tailwindBin: string | undefined
for (const c of tailwindCandidates) {
  if (!(await Bun.file(c).exists())) continue
  const help = await $`${c} --help`.quiet().nothrow().text()
  if (help.includes("tailwindcss v4")) { tailwindBin = c; break }
}
if (!tailwindBin) throw new Error(`no Tailwind 4 CLI found in any of: ${tailwindCandidates.join(", ")}; run bun install`)
await $`${tailwindBin} -i ${src}/styles.css -o ${out}/dashboard.css --minify`.quiet()
const css = await Bun.file(`${out}/dashboard.css`).text()
// A source scan that matches nothing still yields a valid stylesheet (preflight,
// theme, the hand-written classes) with every utility missing — a silent,
// ship-shaped failure. A byte threshold would not catch it reliably now that
// styles.css alone is large, so check for utilities only the sources produce:
// the semantic-token classes exist in the output only when a source uses them.
if (![".bg-brand", ".text-fg-subtle"].every(utility => css.includes(utility))) throw new Error("dashboard.css lacks utilities from the dashboard sources — the @source scan matched nothing")
await Bun.write(`${out}/dashboard.css.txt`, css)

console.log("[build-dashboard] wrote", `${out}/dashboard.js`, "and dashboard.css")
