import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
const root = `${import.meta.dir}/..`
const out = `${root}/packages/gateway/src/control-plane/setup/dist`
const build = await Bun.build({ entrypoints: [`${root}/packages/setup-local/src/cli.ts`], target: "bun", format: "esm", minify: true })
if (!build.success || build.outputs.length !== 1) throw new Error("Setup runner build failed")
const output = build.outputs[0]
if (!output) throw new Error("Setup runner output missing")
const runner = await output.text()
const checksum = createHash("sha256").update(runner).digest("hex")
const assets = {
  "runner.mjs": runner,
  "runner.mjs.txt": runner,
  "runner.sha256.txt": checksum + "\n",
  "setup.sh.txt": (await readFile(`${root}/packages/setup-local/installers/posix/setup.sh`, "utf8")).replaceAll("__RUNNER_SHA256__", checksum),
  "setup.ps1.txt": (await readFile(`${root}/packages/setup-local/installers/powershell/setup.ps1`, "utf8")).replaceAll("__RUNNER_SHA256__", checksum),
}
if (process.argv.includes("--check")) {
  for (const [name, text] of Object.entries(assets)) if (await readFile(`${out}/${name}`, "utf8") !== text) throw new Error("Setup assets are stale")
} else {
  await mkdir(out, { recursive: true })
  for (const [name, text] of Object.entries(assets)) await writeFile(`${out}/${name}`, text)
}
console.log("[build-setup-assets] " + (process.argv.includes("--check") ? "verified current assets" : "wrote public setup assets"))
