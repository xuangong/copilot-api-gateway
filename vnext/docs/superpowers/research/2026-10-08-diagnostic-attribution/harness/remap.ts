import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { fileIdentity, verifyFiles, type FileIdentity, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { analyzeObserverRun, frozenIdentity } from "./analyze"
import { createProfileMapper, summarizeProfile, validateProfile, type FrameMapper } from "./profile"

const declaration = 'modules:[{type:"ESModule",path:join(directory,"entry/entry.mjs")}],modulesRoot:directory'
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T
export function proveModuleIdentity(directory: string, entry: FileIdentity, runtime: FileIdentity) {
  verifyFiles([entry, runtime])
  const root = realpathSync(directory), expected = join(root, "entry/entry.mjs")
  if (resolve(entry.path) !== join(resolve(directory), "entry/entry.mjs") || realpathSync(entry.path) !== expected) throw new Error("Entry differs from exact declared module inside modulesRoot")
  const text = readFileSync(runtime.path, "utf8")
  if (text.split(declaration).length !== 2) throw new Error("Frozen runtime lacks unique exact module declaration")
  return { modulesRoot: root, module: { type: "ESModule", path: expected, relativeUrl: "entry/entry.mjs" }, entry, frozenRuntime: runtime, matchedDeclaration: declaration }
}
export function adaptModuleMapper(proof: ReturnType<typeof proveModuleIdentity>, mapper: FrameMapper): FrameMapper {
  return frame => {
    if (frame.url === proof.module.relativeUrl) return mapper({ ...frame, url: proof.module.path })
    if (!isAbsolute(frame.url) && !frame.url.startsWith("file:")) return null
    try {
      if (frame.url.startsWith("file:")) {
        const url = new URL(frame.url)
        if (url.search || url.hash || /%(2e|2f|5c)/i.test(url.pathname)) return null
      }
      const path = frame.url.startsWith("file:") ? fileURLToPath(frame.url) : frame.url
      if (realpathSync(path) !== proof.module.path) return null
      return mapper(frame)
    } catch { return null }
  }
}

/** Verify frozen collection evidence first, then write a separate offline receipt. */
export async function remapObserverRun(output: string, originalAnalysisPath: string, destination: string) {
  output = resolve(output)
  const original = await analyzeObserverRun(output)
  if (!original.runtimeEvidenceQualified || !original.sourceMappingQualified) throw new Error("Original evidence or source-map proof failed")
  const saved = read<unknown>(originalAnalysisPath)
  if (JSON.stringify(saved) !== JSON.stringify(original)) throw new Error("Original analysis differs from verified frozen evidence")
  const frozen = read<{ inputs: FileIdentity[]; mappingRuntimeInputs: FileIdentity[] }>(join(output, "inputs.json"))
  const manifest = read<Manifest>(join(output, "frozen-manifest.json"))
  const runtimePath = resolve(import.meta.dir, "../../2026-10-07-reference-stage-measurement/harness/runtime.ts")
  const runtime = frozenIdentity(frozen.inputs, runtimePath)
  const proofs: ReturnType<typeof proveModuleIdentity>[] = []
  const rawProfiles: FileIdentity[] = []
  const windows = original.windows.map(window => {
    if (window.mode !== "cpu") return window
    const directory = join(output, "windows", window.id)
    const identity = read<{ entry: FileIdentity; entryMap: FileIdentity; entrySource: FileIdentity; workerBundle: FileIdentity }>(join(directory, "identity.json"))
    const observer = read<{ profile: FileIdentity | null }>(join(directory, "observer-receipt.json"))
    if (!observer.profile) throw new Error("Missing raw profile")
    verifyFiles([observer.profile])
    const proof = proveModuleIdentity(directory, identity.entry, runtime)
    const mapper = createProfileMapper({ generatedConvention: "bun-1.3.0-crlf-double", entry: identity.entry, entryMap: identity.entryMap, bundle: identity.workerBundle, bundleMap: frozenIdentity(frozen.inputs, identity.workerBundle.path + ".map"), approved: [...manifest.variants.B.files, ...manifest.dependencies], harness: [identity.entrySource, ...frozen.inputs.filter(file => file.path.endsWith("/harness/probe-runtime.ts"))] })
    proofs.push(proof); rawProfiles.push(observer.profile)
    return { ...window, profile: summarizeProfile(validateProfile(read<unknown>(observer.profile.path)), adaptModuleMapper(proof, mapper)), mappingQualified: true }
  })
  const analysisTools = [join(import.meta.dir, "remap.ts"), join(import.meta.dir, "remap.test.ts")].map(fileIdentity)
  const receipt = {
    ...original, schema: "diagnostic-observer-remapped-analysis-v1", windows,
    independentRemap: {
      originalAnalysis: fileIdentity(originalAnalysisPath), collectionInputsReceipt: fileIdentity(join(output, "inputs.json")),
      analysisTools, verifiedFrozenAnalysisAndDependencyInputs: frozen.inputs, mappingRuntimeInputs: frozen.mappingRuntimeInputs,
      rawProfiles, moduleIdentityProofs: proofs,
      rule: "Only exact relative entry/entry.mjs adapts to the proved declared module. Absolute/file URLs retain canonical exact-entry checks. Original profiles and collection tools are unchanged.",
      qualificationBoundary: "sourceMappingQualified means a verified mapping proof, not complete frame coverage. Exclusive sparse V8 sample counts and interval weights are not exact CPU or callback duration; no renormalization or process-CPU scaling."
    }
  }
  verifyFiles([...analysisTools, ...frozen.inputs, ...rawProfiles])
  durableJson(destination, receipt, true)
  return receipt
}
if (import.meta.main) {
  const [output, destination] = process.argv.slice(2)
  if (!output || !destination) throw new Error("Usage: bun remap.ts <observer-run> <new-analysis.json>")
  await remapObserverRun(output, join(resolve(output), "../analysis-02.json"), destination)
  console.log(JSON.stringify({ destination: resolve(destination), completed: true }))
}
