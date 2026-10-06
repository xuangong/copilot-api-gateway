import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { frozenReader, parseLock, lockAgreement } from "./build.ts"
import { fileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest.ts"

const ownedDirectories: string[] = []
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "measurement-frozen-reader-")))
  ownedDirectories.push(root)
  return root
}
afterEach(() => { for (const root of ownedDirectories.splice(0)) rmSync(root, { recursive: true }) })

test("compiler input rejects file changes after identity resolution", () => {
  const path = join(fixture(), "module.ts")
  writeFileSync(path, "export const value = 1\n")
  const approved = fileIdentity(path)
  const read = frozenReader([approved])
  writeFileSync(path, "export const value = 2\n")
  expect(() => read(path)).toThrow("frozen identity")
})

test("frozen reader rejects unapproved modules and conflicting approved identities", () => {
  const path = join(fixture(), "module.ts")
  writeFileSync(path, "export const value = 1\n")
  const approved = fileIdentity(path)
  expect(() => frozenReader([])(path)).toThrow("frozen identity")
  expect(() => frozenReader([approved, { ...approved, bytes: approved.bytes + 1 }])).toThrow("conflicting")
})

test("bytes passed to the compiler and consumption receipt describe the same snapshot", () => {
  const path = join(fixture(), "module.ts")
  const source = "export const value = 'original'\n"
  writeFileSync(path, source)
  const approved = fileIdentity(path)
  const read = frozenReader([approved])
  const loaded = read(path)
  writeFileSync(path, "export const value = 'changed'\n")
  expect(loaded.contents.toString("utf8")).toBe(source)
  expect(loaded.identity).toEqual(approved)
  expect(() => read(path)).toThrow("frozen identity")
})

test("Bun onLoad consumes the checked bytes for source and text assets", async () => {
  const root = fixture()
  const entry = join(root, "module.ts")
  const asset = join(root, "fixture.txt")
  writeFileSync(entry, "import text from './fixture.txt'\nexport default text\n")
  writeFileSync(asset, "approved asset")
  const read = frozenReader([fileIdentity(entry), fileIdentity(asset)])
  const consumed: string[] = []
  const result = await Bun.build({ entrypoints: [entry], target: "browser", plugins: [{ name: "checked-byte-qualification", setup(builder) {
    builder.onLoad({ filter: /.*/ }, args => {
      const loaded = read(args.path)
      consumed.push(loaded.identity.path)
      if (args.path === asset) writeFileSync(asset, "changed after checked read")
      return { contents: loaded.contents, loader: args.loader }
    })
  } }] })
  expect(result.success).toBe(true)
  expect(consumed.sort()).toEqual([entry, asset].sort())
  const compiled = await result.outputs[0]!.text()
  expect(compiled).toContain("approved asset")
  expect(compiled).not.toContain("changed after checked read")
  expect(readFileSync(asset, "utf8")).toBe("changed after checked read")
})

test("lock parsing retains quoted delimiters and lock agreement rejects dependency drift", () => {
  const parsed = parseLock('{"packages":{"x":["x@1", ",}",],},}')
  expect(parsed.packages.x).toEqual(["x@1", ",}"])
  expect(lockAgreement(parsed.packages, parsed.packages, "x", "1").version).toBe("1")
  expect(() => lockAgreement(parsed.packages, { x: ["x@2", ",}"] }, "x", "1")).toThrow("lock identity")
})
