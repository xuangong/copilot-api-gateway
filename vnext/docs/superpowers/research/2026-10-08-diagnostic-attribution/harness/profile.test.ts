import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { fileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { validateProfile, summarizeProfile, createProfileMapper } from "./profile"

const frame = (functionName = "(root)", url = "", lineNumber = -1) => ({ functionName, url, lineNumber, columnNumber: lineNumber < 0 ? -1 : 0 })
const profile = () => ({ nodes: [
  { id: 7, callFrame: frame(), children: [8, 9, 10] },
  { id: 8, callFrame: frame("(idle)") },
  { id: 9, callFrame: frame("(garbage collector)") },
  { id: 10, callFrame: frame("native callback") },
], startTime: 100, endTime: 1000, samples: [8, 9, 10], timeDeltas: [100, 0, 500] })

test("keeps first-delta weighting and tail separate without inventing CPU", () => {
  const p = validateProfile(profile())
  const result = summarizeProfile(p, () => { throw new Error("Native frame must not map") })
  expect(result.sampleCount).toBe(3)
  expect(result.firstDeltaUs).toBe(100)
  expect(result.coveredUs).toBe(600)
  expect(result.tailUs).toBe(300)
  expect(result.buckets.map(x => [x.kind, x.sampleCount, x.sampleWeightUs])).toEqual([["runtime", 1, 500], ["idle", 1, 100], ["gc", 1, 0]])
})

test("empty profile is retained as insufficient rather than zero CPU", () => {
  const p = validateProfile({ ...profile(), samples: [], timeDeltas: [] })
  expect(summarizeProfile(p, () => null).hasSamples).toBe(false)
  expect(summarizeProfile(p, () => null).tailUs).toBe(900)
})

for (const [name, change] of [
  ["missing samples", (p: ReturnType<typeof profile>) => ({ ...p, samples: undefined })],
  ["unequal samples/deltas", (p: ReturnType<typeof profile>) => ({ ...p, timeDeltas: [1] })],
  ["unknown sampled node", (p: ReturnType<typeof profile>) => ({ ...p, samples: [8, 9, 99] })],
  ["negative delta", (p: ReturnType<typeof profile>) => ({ ...p, timeDeltas: [1, -1, 1] })],
  ["nonfinite time", (p: ReturnType<typeof profile>) => ({ ...p, endTime: NaN })],
  ["delta beyond end", (p: ReturnType<typeof profile>) => ({ ...p, timeDeltas: [1, 1, 999] })],
  ["duplicate node", (p: ReturnType<typeof profile>) => ({ ...p, nodes: [...p.nodes, p.nodes[0]] })],
  ["unknown child", (p: ReturnType<typeof profile>) => ({ ...p, nodes: [{ ...p.nodes[0], children: [8, 9, 100] }, ...p.nodes.slice(1)] })],
  ["duplicate child", (p: ReturnType<typeof profile>) => ({ ...p, nodes: [{ ...p.nodes[0], children: [8, 8, 9, 10] }, ...p.nodes.slice(1)] })],
  ["cycle", (p: ReturnType<typeof profile>) => ({ ...p, nodes: [p.nodes[0], { ...p.nodes[1], children: [7] }, ...p.nodes.slice(2)] })],
  ["disconnected root", (p: ReturnType<typeof profile>) => ({ ...p, nodes: [...p.nodes, { id: 20, callFrame: frame() }] })],
  ["multiple parents", (p: ReturnType<typeof profile>) => ({ ...p, nodes: [p.nodes[0], { ...p.nodes[1], children: [9] }, ...p.nodes.slice(2)] })],
] as const) test(`rejects ${name}`, () => expect(() => validateProfile(change(profile()))).toThrow())

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "diagnostic-profile-")))
  const original = join(root, "original.ts"), bundle = join(root, "worker.mjs"), entry = join(root, "entry.mjs"), wrapper = join(root, "wrapper.ts")
  writeFileSync(original, "export const result = 1\n")
  writeFileSync(bundle, "const result = 1\n")
  writeFileSync(entry, "const result = 1\nwrapper()\n")
  writeFileSync(wrapper, "wrapper()\n")
  const map = (sources: string[], sourcesContent: string[], mappings: string) => ({ version: 3, sources, sourcesContent, mappings, names: [] })
  writeFileSync(bundle + ".map", JSON.stringify(map([original], ["export const result = 1\n"], "AAAA")))
  writeFileSync(entry + ".map", JSON.stringify(map([bundle, wrapper], ["const result = 1\n", "wrapper()\n"], "AAAA;ACAA")))
  return { root, original, bundle, entry, wrapper, options: () => ({ entry: fileIdentity(entry), entryMap: fileIdentity(entry + ".map"), bundle: fileIdentity(bundle), bundleMap: fileIdentity(bundle + ".map"), approved: [fileIdentity(original)], harness: [fileIdentity(wrapper)] }) }
}

test("maps exact entry through both frozen maps and isolates harness frames", () => {
  const f = fixture()
  try {
    const mapper = createProfileMapper(f.options())
    expect(mapper(frame("result", pathToFileURL(f.entry).href, 0))).toMatchObject({ kind: "product", source: f.original, line: 1, column: 0 })
    expect(mapper(frame("wrapper", pathToFileURL(f.entry).href, 1))).toMatchObject({ kind: "harness", source: f.wrapper, line: 1 })
    expect(mapper(frame("result", pathToFileURL(join(f.root, "foreign/entry.mjs")).href, 0))).toBeNull()
    expect(mapper(frame("result", pathToFileURL(f.entry).href, 3))).toBeNull()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("source-content drift cannot be classified as frozen product", () => {
  const f = fixture()
  try {
    writeFileSync(f.bundle + ".map", JSON.stringify({ version: 3, sources: [f.original], sourcesContent: ["different bytes"], mappings: "AAAA", names: [] }))
    expect(() => createProfileMapper(f.options())).toThrow("content")
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("unapproved or missing source content stays unmapped", () => {
  const f = fixture()
  try {
    const mapper = createProfileMapper({ ...f.options(), approved: [] })
    expect(mapper(frame("result", pathToFileURL(f.entry).href, 0))).toBeNull()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("identity hash mismatch rejects the map instead of trusting contents", () => {
  const f = fixture()
  try {
    const options = f.options()
    writeFileSync(f.entry + ".map", "{}")
    expect(() => createProfileMapper(options)).toThrow("identity")
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("out-of-range generated frames cannot borrow the preceding mapping", () => {
  const f = fixture()
  try {
    const mapper = createProfileMapper(f.options())
    expect(mapper({ ...frame("result", pathToFileURL(f.entry).href, 0), columnNumber: 999 })).toBeNull()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("source map cannot attribute outside frozen original source bounds", () => {
  const f = fixture()
  try {
    writeFileSync(f.bundle + ".map", JSON.stringify({ version: 3, sources: [f.original], sourcesContent: ["export const result = 1\n"], mappings: "AAoGA", names: [] }))
    expect(() => createProfileMapper(f.options())).toThrow("range")
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("duplicate source index cannot borrow another index content proof", () => {
  const f = fixture()
  try {
    writeFileSync(f.bundle + ".map", JSON.stringify({ version: 3, sources: [f.original, f.original], sourcesContent: ["export const result = 1\n", null], mappings: "ACAA", names: [] }))
    expect(() => createProfileMapper(f.options())).toThrow("Duplicate")
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("explicit frozen Bun convention maps separate generated CRLF prefixes at both levels", () => {
  const f = fixture()
  try {
    const bundle = "/*\r\n*/\nconst result = 1\n", entry = "/*\r\none\r\n*/\nconst result = 1\n"
    writeFileSync(f.bundle, bundle); writeFileSync(f.entry, entry)
    writeFileSync(f.bundle + ".map", JSON.stringify({ version: 3, sources: [f.original], sourcesContent: ["export const result = 1\n"], mappings: ";;;AAAA", names: [] }))
    writeFileSync(f.entry + ".map", JSON.stringify({ version: 3, sources: [f.bundle], sourcesContent: [bundle], mappings: ";;;;;AAEA", names: [] }))
    const mapper = createProfileMapper({ ...f.options(), generatedConvention: "bun-1.3.0-crlf-double" })
    expect(mapper(frame("result", pathToFileURL(f.entry).href, 3))).toMatchObject({ kind: "product", source: f.original, line: 1 })
    expect(mapper(frame("comment", pathToFileURL(f.entry).href, 0))).toBeNull()
    expect(mapper(frame("comment", pathToFileURL(f.entry).href, 1))).toBeNull()
    expect(mapper(frame("comment", pathToFileURL(f.entry).href, 2))).toBeNull()
    expect(() => createProfileMapper(f.options())).toThrow("range")
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test("Bun convention never silently accepts bare CR or range errors", () => {
  const f = fixture()
  try {
    writeFileSync(f.entry, "one\rtwo\n")
    expect(() => createProfileMapper({ ...f.options(), generatedConvention: "bun-1.3.0-crlf-double" })).toThrow("bare CR")
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
