/* eslint-disable no-useless-assignment -- Explicit reference clearing isolates retained-memory samples. */
/* global Bun */
import { createHash } from "node:crypto"
import { createJsonBody, createJsonBodyFromText } from "../../../../packages/provider-llm/src/json-body"

const [mode, kind, sizeText] = process.argv.slice(2)
const mib = Number(sizeText)
if (!mode || !kind || ![1, 10, 50].includes(mib)) throw new Error("usage: mode case MiB")
const targetBytes = mib * 1024 * 1024
const now = () => performance.now()
const mem = () => ({ heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss })
const gc = () => { if (typeof Bun.gc === "function") Bun.gc(true) }
const timings: Record<string, number> = {}
const startup = mem()
let t = now()
let key = "k"
let value = ""
switch (kind) {
  case "ascii": value = "a".repeat(targetBytes - 8); break
  case "control": value = "\n".repeat(Math.floor((targetBytes - 8) / 2)); break
  case "cjk-emoji": value = "中😀".repeat(Math.floor((targetBytes - 8) / 7)); break
  case "lone-surrogate": value = "\ud800".repeat(Math.floor((targetBytes - 8) / 6)); break
  case "giant-key": key = "k".repeat(targetBytes - 8); value = "v"; break
  default: throw new Error("unknown case")
}
let sourceText: string | undefined = JSON.stringify({ [key]: value })
key = ""
value = ""
timings.constructMs = now() - t
const sourceBytes = Buffer.byteLength(sourceText)
const afterSource = mem()
let parsed: unknown
if (mode === "native" || mode === "parse" || mode === "oracle") {
  t = now()
  parsed = JSON.parse(sourceText)
  timings.parseMs = now() - t
}
const afterParse = mem()
if (mode === "parse") {
  gc()
  console.log(JSON.stringify({ mode, kind, mib, sourceBytes, startup, afterSource, afterParse, retainedAfterGc: mem(), timings }))
  process.exit(0)
}
if (mode === "oracle") {
  t = now()
  const canonical = JSON.stringify(parsed)
  const digest = createHash("sha256").update(canonical).digest("hex")
  timings.oracleMs = now() - t
  console.log(JSON.stringify({ mode, kind, mib, sourceBytes, length: Buffer.byteLength(canonical), digest, startup, afterSource, afterParse, timings }))
  process.exit(0)
}
if (mode !== "native" && mode !== "candidate") throw new Error("unknown mode")
t = now()
let body = mode === "native" ? createJsonBody(parsed) : createJsonBodyFromText(sourceText)
const contentLength = body.contentLength
timings.factoryMs = now() - t
const afterFactory = mem()
t = now()
const digest = createHash("sha256")
let length = 0
let maxChunk = 0
let chunks = 0
let reader = body.open().getReader()
while (true) {
  const part = await reader.read()
  if (part.done) break
  length += part.value.byteLength
  maxChunk = Math.max(maxChunk, part.value.byteLength)
  digest.update(part.value)
  chunks++
}
timings.drainMs = now() - t
const afterDrain = mem()
gc()
const retainedWithBody = mem()
body = undefined as unknown as typeof body
reader = undefined as unknown as typeof reader
parsed = undefined
sourceText = undefined
gc()
const retainedAfterRelease = mem()
console.log(JSON.stringify({ mode, kind, mib, sourceBytes, length, contentLength, digest: digest.digest("hex"), maxChunk, chunks, startup, afterSource, afterParse, afterFactory, afterDrain, retainedWithBody, retainedAfterRelease, timings, cpu: process.cpuUsage() }))
