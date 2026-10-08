import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { fileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { proveModuleIdentity, adaptModuleMapper } from "./remap"

const declaration = 'modules:[{type:"ESModule",path:join(directory,"entry/entry.mjs")}],modulesRoot:directory'
test("exact module URL adapts without broad relative path acceptance or frame mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "remap-"))
  try {
    mkdirSync(join(root, "entry"))
    writeFileSync(join(root, "entry/entry.mjs"), "x")
    writeFileSync(join(root, "runtime.ts"), declaration)
    const entry = fileIdentity(join(root, "entry/entry.mjs"))
    const proof = proveModuleIdentity(root, entry, fileIdentity(join(root, "runtime.ts")))
    const seen: string[] = []
    const mapper = adaptModuleMapper(proof, frame => { seen.push(frame.url); return { kind: "product", source: "x", line: 1, column: 0 } })
    const frame = { functionName: "x", url: "entry/entry.mjs", lineNumber: 0, columnNumber: 0 }
    expect(mapper(frame)?.kind).toBe("product")
    expect(frame.url).toBe("entry/entry.mjs")
    for (const url of ["./entry/entry.mjs", "../entry/entry.mjs", "entry/entry.mjs?x", "entry/entry.mjs#x", "%65ntry/entry.mjs", "/foreign/entry/entry.mjs", "file:///foreign/entry/entry.mjs", pathToFileURL(entry.path).href + "?x", pathToFileURL(entry.path).href + "#x"]) expect(mapper({ ...frame, url })).toBeNull()
    expect(mapper({ ...frame, url: entry.path })?.kind).toBe("product")
    expect(mapper({ ...frame, url: pathToFileURL(entry.path).href })?.kind).toBe("product")
    expect(seen).toEqual([proof.module.path, entry.path, pathToFileURL(entry.path).href])
    writeFileSync(entry.path, "changed")
    expect(() => proveModuleIdentity(root, entry, fileIdentity(join(root, "runtime.ts")))).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test("module proof rejects escaped symlink and unproved or duplicate declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "remap-")), foreign = mkdtempSync(join(tmpdir(), "foreign-"))
  try {
    mkdirSync(join(root, "entry"))
    writeFileSync(join(foreign, "entry.mjs"), "x")
    symlinkSync(join(foreign, "entry.mjs"), join(root, "entry/entry.mjs"))
    writeFileSync(join(root, "runtime.ts"), declaration)
    expect(() => proveModuleIdentity(root, fileIdentity(join(root, "entry/entry.mjs")), fileIdentity(join(root, "runtime.ts")))).toThrow()
    rmSync(join(root, "entry/entry.mjs")); writeFileSync(join(root, "entry/entry.mjs"), "x")
    for (const text of ["modulesRoot: other", declaration + declaration]) {
      writeFileSync(join(root, "runtime.ts"), text)
      expect(() => proveModuleIdentity(root, fileIdentity(join(root, "entry/entry.mjs")), fileIdentity(join(root, "runtime.ts")))).toThrow()
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(foreign, { recursive: true, force: true }) }
})
