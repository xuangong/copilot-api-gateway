import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { declaredDependency, packagePath, verifyResolution } from "./resolution.ts"
test("resolution proof rejects a retargeted runtime link even when original files remain intact", () => {
  const root = mkdtempSync(join(tmpdir(), "resolution-proof-"))
  for (const dir of ["node_modules", "one", "two"]) mkdirSync(join(root, dir))
  for (const name of ["one", "two"]) writeFileSync(join(root, name, "package.json"), JSON.stringify({ name: "runtime", version: "1" }))
  const link = join(root, "node_modules/runtime")
  symlinkSync(join(root, "one"), link)
  const edge = { name: "runtime", from: root, packageJson: packagePath("runtime", root), optional: false }
  verifyResolution([edge])
  unlinkSync(link); symlinkSync(join(root, "two"), link)
  expect(() => verifyResolution([edge])).toThrow("Resolution drift")
})
test("bare dependency resolution belongs to its importer and rejects undeclared imports", () => {
  const root = mkdtempSync(join(tmpdir(), "importer-proof-"))
  for (const dir of ["one", "two"]) mkdirSync(join(root, dir))
  writeFileSync(join(root, "one/package.json"), JSON.stringify({ name: "one", dependencies: { library: "1" } }))
  writeFileSync(join(root, "two/package.json"), JSON.stringify({ name: "two", dependencies: { library: "2" } }))
  expect(declaredDependency(join(root, "one/source.ts"), "library").range).toBe("1")
  expect(declaredDependency(join(root, "two/source.ts"), "library").range).toBe("2")
  expect(() => declaredDependency(join(root, "one/source.ts"), "undeclared")).toThrow("Undeclared")
})
