import { createHash } from "node:crypto"

/** Build-time only. Paths are relative to vnext/ for A/B and the repo for R. */
export type Arm = "A" | "B" | "R"
type Rule = { id: string; before: string; after: string; expected: number }
type Target = { sha256: string; rules: Rule[] }

export const probeSymbol = "gateway.measurement.probe"

// Every module gets an unexported synchronous helper. The request-owned callback
// is installed by the isolated runtime wrapper, never by product modules.
// A broken observer must not replace a product return value or exception.
const helper = `// Measurement build only; no payload or request objects enter this callback.
const __gatewayMeasurementKey = Symbol.for("${probeSymbol}")
function __gatewayMeasurement(kind: string, name: string, value?: number): void {
  try {
    const callback = (globalThis as unknown as Record<symbol, unknown>)[__gatewayMeasurementKey]
    if (typeof callback === "function") callback(kind, name, value)
  } catch { /* measurement callback failures must be recorded by its owner */ }
}
`

const mark = (name: string) => `__gatewayMeasurement("mark", "${name}")`
const count = (name: string, value = "1") => `__gatewayMeasurement("count", "${name}", ${value})`
const rule = (id: string, before: string, after: string, expected = 1): Rule => ({ id, before, after, expected })
const after = (id: string, anchor: string, statement: string, expected = 1): Rule => rule(id, anchor, `${anchor}\n${statement}`, expected)
const before = (id: string, anchor: string, statement: string, expected = 1): Rule => rule(id, anchor, `${statement}\n${anchor}`, expected)

const chatHttp = [
  after("auth-ready", "  const auth = readAuth(c)", `  ${mark("auth.ready")}`),
  before("body-parsed", "  const disconnect = new ClientDisconnect(c.req.raw.signal)", `  ${mark("body.parsed")}`),
]
const dumpOpen = [
  after("body-ready", "  const requestBody = await readRequestBody(c)", `  ${mark("body.ready")}\n  ${count("request.body.bytes", "requestBody.bytes.byteLength")}`),
]
const config = [
  rule("configuration-copy", "const copy = <T>(value: T): T => structuredClone(value)", `const copy = <T>(value: T): T => (${count("configuration.copy.calls")}, structuredClone(value))`),
  rule("configuration-ready", "  async pinnedView(): Promise<DataPlaneConfiguration> {\n    const snapshot = await this.get()", `  async pinnedView(): Promise<DataPlaneConfiguration> {\n    const snapshot = await this.get()\n    ${mark("configuration.ready")}`),
]
const performanceUpstream = [
  before("provider-call", "  if (!recorder) return fetch()", `  ${mark("provider.call")}\n  ${count("provider.calls")}`),
  after("provider-return", "    const result = await fetch()", `    ${mark("provider.return")}`),
  after("upstream-frame", "  for await (const frame of frames) {", `    ${count("upstream.observed.frames")}\n    if (frame.type === "event") ${count("upstream.observed.events")}`),
]
const directFetch = [
  rule("http-dispatch", "export const directFetcher: Fetcher = (url, init) => fetch(url, init)", `export const directFetcher: Fetcher = (url, init) => (${mark("http.dispatch")}, ${count("http.dispatches")}, fetch(url, init))`),
]
const retry = [
  before("transport-call", "      const response = await fetchImpl(String(input), {", `      ${mark("transport.call")}`),
  before("transport-return", "      if (response.status >= 400 && response.status < 500 && response.status !== 429) {", `      ${mark("transport.return")}`),
]
const legacyDump = [
  before("dump-put-start", "      await getDumpStore().put(this.apiKey.id, record)", `      ${mark("sink.dump.persist.start")}`),
  after("dump-put-complete", "      await getDumpStore().put(this.apiKey.id, record)", `      ${mark("sink.dump.persisted")}`),
  after("dump-publication-complete", "      await getDumpBroker().publish(this.apiKey.id, meta)", `      ${mark("sink.dump.published")}`),
]

const definitions: Record<Arm, Record<string, Target>> = {
  A: {
    "packages/gateway/src/data-plane/chat-flow/chat-completions/http.ts": { sha256: "f1fb0726ddfb919ccbe218b2e026acf0cd6568845d71d13c80bb82219a6f76c6", rules: chatHttp },
    "packages/gateway/src/data-plane/chat-flow/shared/dump-open.ts": { sha256: "f9cfabb283e40f3045a07385111579cf2ec8e3aaa25259f8f7e5ddc2de461911", rules: dumpOpen },
    "packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts": { sha256: "d8574013e96cc2b9de47f31a1a99f2ef3e3bc1c4f49567fad16f962ffca2c5f7", rules: [
      before("routing-start", "  const enumerate: EnumerateFn = args.enumerate ?? enumerateBindingCandidates", `  ${mark("routing.start")}`),
      before("routing-candidates", "  if (catalogUnavailable) return { kind: 'catalog-unavailable', bareModel }", `  ${mark("routing.enumerated")}\n  ${count("routing.candidates", "candidates.length")}`),
      before("routing-ready", "  return {\n    kind: 'ok',", `  ${mark("routing.ready")}`),
    ] },
    "packages/gateway/src/data-plane/chat-flow/shared/performance-upstream.ts": { sha256: "3b13e33c409848db12732e66a697912be21363d64ec921621e7ee413fdfe30b5", rules: performanceUpstream },
    "packages/gateway/src/repo/configuration-cache.ts": { sha256: "04a5145bee3be064146647e3b54ebeaf378581ea39c839bd7f88ca6656508200", rules: [config[0]!,
      rule("configuration-ready", "  async pinnedView(): Promise<Repo> {\n    const snapshot = await this.get()", `  async pinnedView(): Promise<Repo> {\n    const snapshot = await this.get()\n    ${mark("configuration.ready")}`),
    ] },
    "packages/upstream/src/fetcher.ts": { sha256: "1e1c4ced362392cf06fe845610e669295394ad1077563a1f40ff32dd4b652fca", rules: directFetch },
    "packages/http/src/fetch-retry.ts": { sha256: "1fdc2faf06da6672fa70eba95149ee77d4a069ace06f846b4aa53f122b4fcb33", rules: retry },
    "packages/result/src/parse-sse.ts": { sha256: "61f72c3415e16fcdc736b7c86e5b300c8f03591675931bb4ef0b1f2c854fb87a", rules: [
      rule("sse-frame", "        if (frame) yield frame", `        if (frame) { ${count("sse.parsed.frames")}; yield frame }`, 2),
      before("sse-bytes", "      buffer += decoder.decode(value, { stream: true })", `      ${count("sse.input.chunks")}\n      ${count("sse.input.bytes", "value.byteLength")}`),
    ] },
    "packages/gateway/src/repo/dump-store.ts": { sha256: "cdff47fa521fee5c497b6e8345f04d2c05e2f7c5dc07332ebc4119d3504ab02b", rules: [
      after("request-preparation", "  async prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> {", `    ${mark("sink.request.prepare.start")}`),
      rule("request-prepared", "      decodedByteLength: body.byteLength,", `      decodedByteLength: (${mark("sink.request.prepared")}, body.byteLength),`),
      after("gzip-input", "const gzip = async (input: Uint8Array): Promise<Uint8Array> => {", `  ${count("compression.calls")}\n  ${count("compression.input.bytes", "input.byteLength")}`),
      before("file-put", "  await files.put(key, gz)", `  ${count("sink.files.puts")}\n  ${count("sink.files.bytes", "gz.byteLength")}`, 2),
    ] },
    "packages/gateway/src/shared/dump/accumulator.ts": { sha256: "7c9f78c32698275a3a92e9c8d4e8934f531780468c1722c9fea055ab384712a1", rules: legacyDump },
  },
  B: {
    "packages/gateway/src/data-plane/chat-flow/chat-completions/http.ts": { sha256: "f1fb0726ddfb919ccbe218b2e026acf0cd6568845d71d13c80bb82219a6f76c6", rules: chatHttp },
    "packages/gateway/src/data-plane/chat-flow/shared/dump-open.ts": { sha256: "b707c4119e3bac88e3cbd0f47a928c7e06ce97bf34de4c21a690741990ba298d", rules: dumpOpen },
    "packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts": { sha256: "90023cce5e7be6d9870b349a16dc65fdcc23ea3120940e4cb2317d12bc966cc5", rules: [
      before("routing-start", "  const enumeration = await (args.enumerate ?? enumerateBindingCandidates)({", `  ${mark("routing.start")}`),
      after("routing-candidates", "  const bareModel = enumeration.bareModel", `  ${mark("routing.enumerated")}\n  ${count("routing.candidates", "enumeration.candidates.length")}`),
      before("routing-ready", '  return { kind: "ok", binding: first.binding, targetEndpoint: first.targetEndpoint, translator, bareModel }', `  ${mark("routing.ready")}`),
    ] },
    "packages/gateway/src/data-plane/chat-flow/shared/performance-upstream.ts": { sha256: "3b13e33c409848db12732e66a697912be21363d64ec921621e7ee413fdfe30b5", rules: performanceUpstream },
    "packages/gateway/src/repo/configuration-cache.ts": { sha256: "07d8dd9ab481c5c0590b11251ecfb9a8947f70a8de848bddf26f1f50e598a427", rules: config },
    "packages/upstream/src/fetcher.ts": { sha256: "1e1c4ced362392cf06fe845610e669295394ad1077563a1f40ff32dd4b652fca", rules: directFetch },
    "packages/http/src/fetch-retry.ts": { sha256: "257b8f199b97e4fc8dc4e2b138afdd51e465abf964fe85a3b04d6b2866cd197d", rules: retry },
    "packages/result/src/parse-sse.ts": { sha256: "5f8e708a1c588f1eb02e0e396cd4fa07929d8e06602ea0e522ed8a3f4359c295", rules: [
      rule("sse-frame", "      return frame\n    }", `      if (frame) ${count("sse.parsed.frames")}\n      return frame\n    }`),
      before("sse-bytes", "      for (const frame of feed(decoder.decode(value, { stream: true }))) {", `      ${count("sse.input.chunks")}\n      ${count("sse.input.bytes", "value.byteLength")}`),
    ] },
    "packages/gateway/src/repo/dump-store.ts": { sha256: "4baae7eccf2e81cd0200882e659206b20c47158ae0b969563b3bb7dbbb2b04c2", rules: [
      after("request-preparation", "  prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> {", `    ${mark("sink.request.prepare.start")}`),
      rule("request-prepared", '      return gzip(body).then(bytes => ({ encoding: "gzip", bytes, decodedByteLength }))', `      return gzip(body).then(bytes => (${mark("sink.request.prepared")}, { encoding: "gzip", bytes, decodedByteLength }))`),
      after("gzip-input", 'const gzip = (input: Uint8Array | string, ownership: "borrowed" | "transferred" = "borrowed"): Promise<Uint8Array> => {', `  ${count("compression.calls")}\n  if (typeof input === "string") ${count("compression.input.codeUnits", "input.length")}\n  else ${count("compression.input.bytes", "input.byteLength")}`),
      rule("file-put", "  if (key !== null && bytes !== null) return files.put(key, bytes)", `  if (key !== null && bytes !== null) return (${count("sink.files.puts")}, ${count("sink.files.bytes", "bytes.byteLength")}, files.put(key, bytes))`),
      before("dump-prepared", "    return prepared\n  } catch (error) {", `    ${mark("sink.dump.prepared")}`),
      after("dump-persist-start", "const persistPreparedDump = async (db: SqlDatabase, files: FileProvider, prepared: PreparedDumpWrite): Promise<void> => {", `  ${mark("sink.dump.persist.start")}`),
      after("dump-files-settled", "      const upstreamUploaded = await putPreparedDumpBodies(files, prepared, upstreamFileKey)", `      ${mark("sink.dump.files.settled")}`),
    ] },
    "packages/gateway/src/shared/dump/accumulator.ts": { sha256: "cb155264dc88381d8e765d02316cee48530041f75c85c4fddfd38d61b53977f7", rules: [
      rule("dump-put-complete", "  getDumpBroker().publish(keyId, meta)", `  (${mark("sink.dump.persisted")}, getDumpBroker().publish(keyId, meta))`),
    ] },
  },
  R: {
    "packages/gateway/src/middleware/auth.ts": { sha256: "5305d0918448dac1fb3600741447b789d4e9502c02118a0d3a252e453559deef", rules: [
      after("auth-ready", "  if (!(await authenticateApiKey(c, rawKey))) return c.json({ error: 'Unauthorized' }, 401);", `  ${mark("auth.ready")};`),
    ] },
    "packages/gateway/src/data-plane/chat/openai-chat-completions/http.ts": { sha256: "06ab4f61b0cf15c7570401a744d3d99c2ece60439d542cdb62d1f8e4dab591a3", rules: [
      after("body-ready", "    const requestBody = await readRequestBody(c);", `    ${mark("body.ready")};\n    ${count("request.body.bytes", "requestBody.bytes.byteLength")};`),
      after("body-parsed", "      const payload = JSON.parse(new TextDecoder().decode(requestBody.bytes)) as OpenAIChatCompletionsPayload;", `      ${mark("body.parsed")};`),
    ] },
    "packages/gateway/src/data-plane/chat/openai-chat-completions/serve.ts": { sha256: "8c3a5a302ecc0b9522b5db616064012f3f790751d932b339575005e6025baafa", rules: [
      before("routing-start", "    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({", `    ${mark("routing.start")};`),
      before("routing-candidates", "    const affinity = await analyzeOpenAIChatCompletionsAffinity(payload, ctx.affinity.codec);", `    ${mark("routing.enumerated")};\n    ${count("routing.candidates", "enumerated.length")};`),
      before("routing-ready", "    return await iterateCandidates(", `    ${mark("routing.ready")};\n    ${count("routing.selected.candidates", "selection.candidates.length")};`),
    ] },
    "packages/gateway/src/data-plane/chat/openai-chat-completions/attempt.ts": { sha256: "6b20d1f015b03ad795b6d030487395996cf47e20ba1704cc47f03e1506d51c95", rules: [
      before("provider-call", "        const providerResult = await candidate.provider.instance.callOpenAIChatCompletions(", `        ${mark("provider.call")};\n        ${count("provider.calls")};`),
      before("provider-return", "        return await providerStreamResultToExecuteResult(providerResult, candidate, 'openaiChatCompletions', ctx, billableUsageFromOpenAIChatCompletionsEvent);", `        ${mark("provider.return")};`),
    ] },
    "packages/gateway/src/data-plane/shared/iterate-candidates.ts": { sha256: "0b745356760bdee74f401cfda7370ea6d0bc107fc98b27d8ccc8a43dd7bb044a", rules: [
      after("candidate-attempt", "  for (const candidate of candidates) {", `    ${count("routing.attempted.candidates")};`),
    ] },
    "apps/platform-cloudflare/src/fetch.ts": { sha256: "bd42515fbb839496f27969e42cda45c5e303a31e524c8eff14da7370a7eb68d0", rules: [
      rule("http-dispatch-plain", "  if (!isReplayableBody(body)) return fetch(url, { ...init, body });", `  if (!isReplayableBody(body)) return (${mark("http.dispatch")}, ${count("http.dispatches")}, fetch(url, { ...init, body }));`),
      rule("http-dispatch-replayable", "  return fetch(url, { ...init, body: fixed.readable });", `  return (${mark("http.dispatch")}, ${count("http.dispatches")}, fetch(url, { ...init, body: fixed.readable }));`),
    ] },
    "packages/provider-custom/src/fetch.ts": { sha256: "c19472f868145ff3229a676b468195e39dd117cace4452a9dbcf0b009e8873d9", rules: [
      rule("transport-call-return", "  return await options.wrapUpstreamCall(() => options.fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers }));", `  ${mark("transport.call")};\n  const __gatewayMeasurementResponse = await options.wrapUpstreamCall(() => options.fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers }));\n  ${mark("transport.return")};\n  return __gatewayMeasurementResponse;`),
    ] },
    "packages/protocols/src/common/parse-sse.ts": { sha256: "3eecfd06d265e4ef892f599b75dd50283d5cd2594dd3f625c19e89e867274d02", rules: [
      before("sse-frame", "      pendingFrames.push(sseFrame(event.data, event.event));", `      ${count("sse.parsed.frames")};`),
      before("sse-bytes", "      parser.feed(decoder.decode(value, { stream: true }));", `      ${count("sse.input.chunks")};\n      ${count("sse.input.bytes", "value.byteLength")};`),
    ] },
    "packages/gateway/src/shared/gzip.ts": { sha256: "1b4679dcefabd73bfe576a713af8046e448d1f75ca06651a8ab008ee537a8757", rules: [
      rule("gzip-input", "export const gzipBytes = async (bytes: Uint8Array): Promise<Uint8Array> =>\n  await collect(bytesStream(bytes).pipeThrough(new CompressionStream('gzip')));", `export const gzipBytes = async (bytes: Uint8Array): Promise<Uint8Array> =>\n  (${count("compression.calls")}, ${count("compression.input.bytes", "bytes.byteLength")}, await collect(bytesStream(bytes).pipeThrough(new CompressionStream('gzip'))));`),
    ] },
    "packages/gateway/src/repo/dump-store.ts": { sha256: "d713ccfbbbdf9b491837ca9403eb8fb9c62b68723838caa5b47de6707f012f15", rules: [
      after("request-preparation", "  async prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> {", `    ${mark("sink.request.prepare.start")};`),
      rule("request-prepared", "      decodedByteLength: body.byteLength,", `      decodedByteLength: (${mark("sink.request.prepared")}, body.byteLength),`),
      before("file-put", "  await files.put(key, gz);", `  ${count("sink.files.puts")};\n  ${count("sink.files.bytes", "gz.byteLength")};`, 2),
    ] },
    "packages/gateway/src/dump/accumulator.ts": { sha256: "e51a685281bd0e8e3fe8aec059cad3cffcf3b6cc8a3b4e9d8a9f44e2207fe498", rules: [
      before("dump-put-start", "      await getDumpStore().put(this.apiKey.id, record);", `      ${mark("sink.dump.persist.start")};`),
      after("dump-put-complete", "      await getDumpStore().put(this.apiKey.id, record);", `      ${mark("sink.dump.persisted")};`),
      after("dump-publication-complete", "      await getDumpBroker().publish(this.apiKey.id, meta);", `      ${mark("sink.dump.published")};`),
    ] },
  },
}

export interface HookCoverage {
  supported: readonly string[]
  missing: readonly string[]
  qualifications: readonly string[]
}

/** These are coverage statements, not measurements or semantic qualification. */
export function coverage(arm: Arm): HookCoverage {
  return {
    supported: ["auth.ready", "body.ready", "body.parsed", "routing.start", "routing.enumerated", "routing.ready", "provider.call", "provider.return", "http.dispatch", "transport.call", "transport.return", "sink.request.prepare.start", "sink.request.prepared", "sink.dump.persist.start", "sink.dump.persisted", "request.body.bytes", "routing.candidates", "provider.calls", "http.dispatches", "sse.parsed.frames", "sse.input.chunks", "sse.input.bytes", "compression.calls", "sink.files.puts", "sink.files.bytes", ...(arm === "R" ? ["routing.selected.candidates", "routing.attempted.candidates", "sink.dump.published"] : ["configuration.ready", "configuration.copy.calls", "upstream.observed.frames", "upstream.observed.events"]), ...(arm === "A" ? ["sink.dump.published"] : []), ...(arm === "B" ? ["sink.dump.prepared", "sink.dump.files.settled", "compression.input.codeUnits"] : []), "compression.input.bytes"],
    missing: ["Exact runtime fetch fulfillment/rejection has no existing continuation; no extra Promise reaction is inserted.", "SQL rows, cache hit/miss details, ownership byte-seconds/high-water, queue depth, first semantic output, render enqueue, cancellation/owner release, and total settlement require separate qualified probes.", ...(arm === "R" ? ["No shared configuration snapshot/copy implementation equivalent to the A/B cache hook; absence is not zero cost.", "Provider boundary currently covers native OpenAI Chat only, not translated/provider-specific calls."] : ["provider.return is only emitted on the existing recorder-enabled await path; no-recorder return remains untouched."]), ...(arm === "B" ? ["Dump publication completion has no existing continuation; sink.dump.persisted precedes publication, not request settlement."] : [])],
    qualifications: ["Hooks only emit fixed names and numeric counts; runtime wrapper supplies request/attempt ownership, worker clock, bounds and recording errors.", "http.dispatch is direct runtime fetch invocation only. Proxy paths and model discovery are not inferred from absence; fixture qualification must verify matching dispatch counts.", "transport.return marks an existing await continuation (A/B retry wrapper, R custom fetch), not an exact network-header timestamp.", "routing.ready is successful candidate selection, not completion of every interceptor or provider preparation operation.", "Parsed SSE frame counts include protocol terminators such as [DONE], not just semantic text events.", "sink.files.puts/bytes are attempted writes, including failed/retried writes; they are not physical successful object counts.", "String compression input is counted in UTF-16 code units in B; no new UTF-8 encoding is performed and unlike-unit totals must not be compared.", "Request and dump preparation can overlap routing or output. Do not sum overlapping marker intervals as CPU.", "Markers on success paths remain absent on failures. Absence is incomplete coverage, not zero time.", "Frozen full-file SHA-256 plus exact anchor counts reject drift. Requalification is required before updating anchors or hashes."],
  }
}

export function hookTargets(arm: Arm): string[] { return Object.keys(definitions[arm]) }

export function patchSource(arm: Arm, relativePath: string, source: string): { source: string; applied: string[] } {
  const target = definitions[arm][relativePath]
  if (!target) return { source, applied: [] }
  for (const item of target.rules) {
    const found = source.split(item.before).length - 1
    if (found !== item.expected) throw new Error(`Measurement anchor ${arm}:${relativePath}:${item.id}: expected ${item.expected}, found ${found}; source drift`)
  }
  if (createHash("sha256").update(source).digest("hex") !== target.sha256) {
    throw new Error(`Measurement source drift: ${arm}:${relativePath}; frozen SHA-256 mismatch`)
  }
  if (source.includes("__gatewayMeasurement")) throw new Error(`Measurement helper collision: ${arm}:${relativePath}`)
  let patched = source
  for (const item of target.rules) patched = patched.replaceAll(item.before, item.after)
  return { source: `${helper}\n${patched}`, applied: target.rules.map(item => `${relativePath}:${item.id}`) }
}
