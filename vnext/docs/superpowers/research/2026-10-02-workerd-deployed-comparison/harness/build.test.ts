import { expect, test } from "bun:test"
import { parseLock, lockAgreement, workspaceExports, resolveDeclaredImport } from "./build.ts"
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CANDIDATE } from "./manifest.ts"
test("lock parsing preserves quoted comma-delimiter strings and rejects shared dependency drift", () => {
  const parsed = parseLock('{"packages":{"x":["x@1", ",}",],},}')
  expect(parsed.packages.x).toEqual(["x@1", ",}"])
  expect(lockAgreement(parsed.packages, parsed.packages, "x", "1").version).toBe("1")
  expect(() => lockAgreement(parsed.packages, { x: ["x@2", ",}"] }, "x", "1")).toThrow("lock identity")
})
test("workspace exports retain variant source ownership", () => {
  const exports = workspaceExports(CANDIDATE)
  expect(exports.get("@vibe-llm/gateway")?.startsWith(CANDIDATE + "/vnext/packages/gateway/")).toBe(true)
})

test("resolver selects the importer's installed version rather than a gateway-wide dependency", () => {
  const root = mkdtempSync(join(tmpdir(), "import-version-proof-"))
  for (const [directory, version] of [["one", "1"], ["two", "2"]]) {
    if (!directory || !version) throw new Error("Missing fixture")
    mkdirSync(join(root, directory, "node_modules/library"), { recursive: true })
    writeFileSync(join(root, directory, "package.json"), JSON.stringify({ name: directory, dependencies: { library: version } }))
    writeFileSync(join(root, directory, "node_modules/library/package.json"), JSON.stringify({ name: "library", version, main: "index.js" }))
    writeFileSync(join(root, directory, "node_modules/library/index.js"), `export default ${version}`)
  }
  expect(resolveDeclaredImport("library", join(root, "one/source.ts"), root, root).path).toBe(realpathSync(join(root, "one/node_modules/library/index.js")))
  expect(resolveDeclaredImport("library", join(root, "two/source.ts"), root, root).path).toBe(realpathSync(join(root, "two/node_modules/library/index.js")))
  expect(() => resolveDeclaredImport("undeclared", join(root, "one/source.ts"), root, root)).toThrow("Undeclared")
})
