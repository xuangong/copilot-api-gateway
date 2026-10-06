import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, extname, join, relative, resolve } from "node:path"
import { gunzipSync } from "node:zlib"

type Obj = Record<string, unknown>
type Package = { name?: string; version?: string; exports?: Record<string, string | { import?: string }>; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
type Lock = { importers: Record<string, { dependencies?: Record<string, { specifier: string; version: string }> }>; packages: Record<string, { resolution?: { integrity?: string } }>; snapshots?: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>; patchedDependencies?: Record<string, { path: string; hash: string }> }
export interface ReferenceInput { path: string; sha256: string }
export interface ReferenceBuildOptions { transform?: (relativePath: string, source: string) => { source: string; applied: string[] } }
export interface ReferenceDatabase {
  prepare(sql: string): { all<T>(): Promise<{ results: T[] }>; bind(...values: (string | number | null)[]): { run(): Promise<unknown> } }
}
export interface ReferenceBucket {
  list(options: { limit: number; cursor?: string }): Promise<{ truncated: boolean; cursor?: string; objects: { key: string; size: number }[] }>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
}
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const object = (value: unknown, label: string): Obj => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid reference ${label}`)
  return value as Obj
}
const nameOf = (specifier: string) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0] ?? specifier
const plainVersion = (version: string) => version.split("(")[0] ?? version
function packageManifest(name: string, from: string): string {
  for (let directory = from;; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name, "package.json")
    if (existsSync(candidate)) return realpathSync(candidate)
    if (dirname(directory) === directory) throw new Error(`Missing reference dependency ${name} from ${from}`)
  }
}
function ownerManifest(path: string): string {
  for (let directory = dirname(path);; directory = dirname(directory)) {
    const candidate = join(directory, "package.json")
    if (existsSync(candidate)) return candidate
    if (dirname(directory) === directory) throw new Error(`No package owner for ${path}`)
  }
}

/** Build only the real Worker, using this root's installed dependencies and lock. */
export async function buildReference(root: string, out: string, options: ReferenceBuildOptions = {}): Promise<{ bundle: string; migrationRoot: string; inputs: ReferenceInput[]; resolutionNotes: string[] }> {
  root = realpathSync(root)
  out = resolve(out)
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const receiptPath = join(out, "reference-build-receipt.json")
  if (existsSync(receiptPath)) throw new Error(`Reference build output already has a receipt: ${receiptPath}`)
  const inputs = new Map<string, ReferenceInput>()
  const load = (path: string) => {
    path = realpathSync(path)
    if (!path.startsWith(root + "/")) throw new Error(`Reference build input escaped frozen root: ${path}`)
    const bytes = readFileSync(path)
    const identity = { path, sha256: sha(bytes) }
    const previous = inputs.get(path)
    if (previous && previous.sha256 !== identity.sha256) throw new Error(`Reference input changed during build: ${path}`)
    inputs.set(path, identity)
    return bytes.toString("utf8")
  }
  const dependencies: Obj[] = []
  const resolutions: Obj[] = []
  const transforms: { path: string; sha256: string; transformedSha256: string; applied: string[] }[] = []
  const resolutionNotes = ["Real Cloudflare entrypoint; Bun target=node; all cloudflare:* and Node builtins remain external", "Only dependencies installed below the supplied reference root are eligible; no fallback into vNext or the original reference checkout", "Exact resolved dependency versions and consumed bytes are frozen; lock integrity is recorded, not claimed as a new tarball integrity verification"]
  const entrypoint = join(root, "apps/platform-cloudflare/entry.ts")
  const migrationRoot = join(root, "packages/gateway/migrations")
  const receipt = (completed: boolean, error?: unknown) => {
    writeFileSync(receiptPath, JSON.stringify({ completed, root, entrypoint, options: { target: "node", sourcemap: "external", instrumented: !!options.transform }, migrationRoot, inputs: [...inputs.values()], dependencies, resolutions, transforms, resolutionNotes, ...(error ? { error: String(error) } : {}) }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  }
  try {
    const lock = Bun.YAML.parse(load(join(root, "pnpm-lock.yaml"))) as Lock
    load(join(root, "package.json"))
    if (existsSync(join(root, "pnpm-workspace.yaml"))) load(join(root, "pnpm-workspace.yaml"))
    for (const patch of Object.values(lock.patchedDependencies ?? {})) load(resolve(root, patch.path))
    for (const filename of readdirSync(migrationRoot).filter(name => name.endsWith(".sql")).sort()) load(join(migrationRoot, filename))
    const workspace = new Map<string, { directory: string; pkg: Package }>()
    for (const base of ["apps", "packages"]) for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = join(root, base, entry.name)
      if (!existsSync(join(directory, "package.json"))) continue
      const pkg = JSON.parse(load(join(directory, "package.json"))) as Package
      if (pkg.name) workspace.set(pkg.name, { directory, pkg })
    }
    const visited = new Set<string>()
    const inspect = (directory: string, pkg: Package) => {
      if (visited.has(directory)) return
      visited.add(directory)
      const importer = relative(root, directory).replaceAll("\\", "/")
      for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
        const locked = lock.importers[importer]?.dependencies?.[name]
        if (!locked || locked.specifier !== range) throw new Error(`Reference dependency edge differs from lock: ${importer} -> ${name}`)
        const local = workspace.get(name)
        if (local) {
          if (!range.startsWith("workspace:") || !locked.version.startsWith("link:") || realpathSync(resolve(directory, locked.version.slice(5))) !== local.directory) throw new Error(`Reference workspace dependency differs from lock: ${name}`)
          inspect(local.directory, local.pkg)
          continue
        }
        const expectedVersion = plainVersion(locked.version)
        const entry: Obj = { importer, name, expectedVersion, lockEntrySha256: sha(JSON.stringify(lock.packages[`${name}@${expectedVersion}`] ?? null)), status: "missing" }
        try {
          const manifest = packageManifest(name, directory)
          const installed = JSON.parse(load(manifest)) as Package
          Object.assign(entry, { manifest, actualVersion: installed.version, status: installed.name !== name || installed.version !== expectedVersion ? "version_mismatch" : "available" })
          if (!lock.packages[`${name}@${expectedVersion}`]) entry.status = "missing_lock_package"
        } catch (error) { entry.error = String(error) }
        dependencies.push(entry)
      }
    }
    const platform = workspace.get("@floway-dev/platform-cloudflare")
    if (!platform) throw new Error("Reference platform package missing")
    inspect(platform.directory, platform.pkg)
    const blockers = dependencies.filter(entry => entry.status !== "available")
    if (blockers.length) throw new Error(`Reference dependency preflight failed: ${blockers.map(entry => `${entry.name}:${entry.status}`).join(", ")}`)
    const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])
    const result = await Bun.build({
      entrypoints: [entrypoint], outdir: out, naming: "worker.mjs", target: "node", sourcemap: "external",
      plugins: [{ name: "reference-frozen-inputs", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.path.startsWith("cloudflare:") || builtins.has(args.path)) return { path: args.path, external: true }
          const bare = !args.path.startsWith(".") && !args.path.startsWith("/")
          const name = nameOf(args.path)
          const local = bare ? workspace.get(name) : undefined
          let resolved: string
          if (local) {
            const subpath = args.path === name ? "." : "." + args.path.slice(name.length)
            const target = local.pkg.exports?.[subpath]
            const value = typeof target === "string" ? target : target?.import
            if (!value?.startsWith("./")) throw new Error(`Unsupported reference workspace export ${args.path}`)
            const importing = JSON.parse(load(ownerManifest(args.importer))) as Package
            if (!importing.dependencies?.[name]) throw new Error(`Undeclared reference workspace import ${args.path}`)
            resolved = realpathSync(resolve(local.directory, value))
          } else {
            resolved = realpathSync(Bun.resolveSync(args.path, dirname(args.importer || entrypoint)))
            if (bare) {
              const manifest = ownerManifest(resolved)
              const installed = JSON.parse(load(manifest)) as Package
              const importingManifest = ownerManifest(args.importer)
              const importing = JSON.parse(load(importingManifest)) as Package
              if (!importing.dependencies?.[name] && !importing.peerDependencies?.[name] && !importing.optionalDependencies?.[name]) throw new Error(`Undeclared reference dependency import ${name} in ${args.importer}`)
              if (installed.name !== name || !installed.version || !lock.packages[`${name}@${installed.version}`]) throw new Error(`Resolved reference dependency is absent from lock: ${name}`)
              const sourceImporter = relative(root, dirname(importingManifest)).replaceAll("\\", "/")
              let expected = lock.importers[sourceImporter]?.dependencies?.[name]?.version
              if (!expected) {
                const candidates = Object.entries(lock.snapshots ?? {}).filter(([key]) => key === `${importing.name}@${importing.version}` || key.startsWith(`${importing.name}@${importing.version}(`))
                const versions = new Set(candidates.flatMap(([, snapshot]) => { const version = snapshot.dependencies?.[name] ?? snapshot.optionalDependencies?.[name]; return version ? [plainVersion(version)] : [] }))
                if (versions.size !== 1) throw new Error(`Reference transitive dependency edge is unresolved: ${importing.name} -> ${name}`)
                expected = [...versions][0]
              }
              if (!expected || plainVersion(expected) !== installed.version) throw new Error(`Resolved reference dependency version mismatch: ${name}`)
            }
          }
          load(resolved)
          resolutions.push({ specifier: args.path, importer: args.importer, resolved })
          return { path: resolved }
        })
        builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
          const source = load(args.path)
          const isProduct = !args.path.includes("/node_modules/")
          const transformed = isProduct && options.transform ? options.transform(relative(root, args.path).replaceAll("\\", "/"), source) : { source, applied: [] }
          if (isProduct) transforms.push({ path: args.path, sha256: sha(source), transformedSha256: sha(transformed.source), applied: transformed.applied })
          return { contents: transformed.source, loader: extname(args.path).endsWith("tsx") ? "tsx" : /\.[cm]?ts$/.test(args.path) ? "ts" : "js" }
        })
      } }],
    })
    if (!result.success) throw new Error(`Reference build failed: ${result.logs.map(String).join("\n")}`)
    for (const identity of inputs.values()) if (sha(readFileSync(identity.path)) !== identity.sha256) throw new Error(`Reference input changed after build: ${identity.path}`)
    receipt(true)
    return { bundle: join(out, "worker.mjs"), migrationRoot, inputs: [...inputs.values()], resolutionNotes }
  } catch (error) { receipt(false, error); throw error }
}

export async function seedReference(db: ReferenceDatabase, opts: { baseUrl: string; apiKey: string; fixtureSecret: string; dump: boolean; model: string }): Promise<void> {
  const base = new URL(opts.baseUrl)
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password || base.search || base.hash || !["/", "/v1", "/v1/"].includes(base.pathname)) throw new Error("Reference fixture must be a local HTTP origin or /v1 URL without credentials")
  if (![opts.apiKey, opts.fixtureSecret, opts.model].every(value => typeof value === "string" && value.trim().length > 0) || typeof opts.dump !== "boolean") throw new Error("Invalid reference fixture identity")
  const now = "2026-10-07T00:00:00.000Z"
  const endpoints = { openaiChatCompletions: {} }
  const config = JSON.stringify({ baseUrl: base.origin + "/v1", authStyle: "bearer", apiKey: opts.fixtureSecret, ingressHeadersRules: [], modelsFetch: { enabled: false }, endpoints, models: [{ kind: "chat", upstreamModelId: opts.model, publicModelId: opts.model, endpoints }] })
  await db.prepare("INSERT INTO users(username,is_admin,created_at) VALUES(?,?,?)").bind("reference-fixture", 0, now).run()
  const users = (await db.prepare("SELECT id FROM users WHERE username = 'reference-fixture'").all<{ id: number }>()).results
  const user = users[0]
  if (users.length !== 1 || !user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Error("Reference fixture user identity was not persisted uniquely")
  await db.prepare("INSERT INTO api_keys(id,user_id,name,key,server_secret,created_at,dump_retention_seconds,responses_retention_seconds) VALUES(?,?,?,?,?,?,?,?)").bind("reference-key", user.id, "Fixture", opts.apiKey, sha(`reference-measurement-only:${opts.apiKey}`), now, opts.dump ? 0 : null, 0).run()
  await db.prepare("INSERT INTO upstreams(id,provider,name,config_json,proxy_fallback_list_json,hue,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind("custom:reference-fixture", "custom", "Fixture Chat", config, '[{"id":"direct_fetch"}]', 93, now, now).run()
}

type Descriptor = { key: string; type: "bytes" | "events" | "capture" }
export interface ReferencePhysicalObject {
  key: string
  size: number
  type?: Descriptor["type"]
  owner?: { type: Descriptor["type"]; keyId: string; id: string; ownerKind: string }
  compressedSha256: string
  decodedBytes: number
  decodedSha256: string
  decodedBase64: string
  json?: unknown
}
function descriptor(raw: unknown): Descriptor | null {
  if (raw === null) return null
  if (typeof raw !== "string") throw new Error("Invalid reference descriptor JSON")
  const parsed = object(JSON.parse(raw), "descriptor")
  if (Object.keys(parsed).length !== 2 || typeof parsed.key !== "string" || !parsed.key || !["bytes", "events", "capture"].includes(String(parsed.type))) throw new Error("Invalid reference descriptor shape")
  return parsed as unknown as Descriptor
}
function headers(value: unknown) {
  if (!Array.isArray(value) || !value.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(entry => typeof entry === "string"))) throw new Error("Invalid reference header pairs")
}
function rawBody(value: unknown) {
  const body = object(value, "raw body")
  if (typeof body.data !== "string" || !["utf8", "base64"].includes(String(body.encoding))) throw new Error("Invalid reference body encoding")
  if (body.encoding === "base64" && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data) || Buffer.from(body.data, "base64").toString("base64") !== body.data)) throw new Error("Invalid reference base64 body")
}
function rawCapture(value: unknown) {
  const capture = object(value, "raw capture")
  rawBody(capture.body)
  if (typeof capture.complete !== "boolean" || !(capture.error === null || typeof capture.error === "string")) throw new Error("Invalid reference capture completion")
}
function events(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Invalid reference events")
  for (const valueEvent of value) {
    const event = object(valueEvent, "event")
    const frame = object(event.frame, "event frame")
    if (typeof event.ts !== "number" || !Number.isFinite(event.ts) || !["done", "event"].includes(String(frame.type)) || frame.type === "event" && !Object.hasOwn(frame, "event")) throw new Error("Invalid reference event frame")
  }
}
function captureEnvelope(value: unknown) {
  const envelope = object(value, "capture envelope")
  if (envelope.version !== 1) throw new Error("Invalid reference capture version")
  const capture = object(envelope.capture, "capture")
  if (!Array.isArray(capture.exchanges)) throw new Error("Invalid reference exchanges")
  for (const raw of capture.exchanges) {
    const exchange = object(raw, "exchange")
    const request = object(exchange.request, "exchange request")
    if (typeof exchange.upstreamId !== "string" || typeof request.url !== "string" || typeof request.method !== "string" || !(exchange.error === null || typeof exchange.error === "string")) throw new Error("Invalid reference exchange identity")
    headers(request.headers); rawBody(request.body)
    if (exchange.response !== null) {
      const response = object(exchange.response, "exchange response")
      rawCapture(response); headers(response.headers)
      if (typeof response.status !== "number") throw new Error("Invalid reference exchange status")
    }
  }
  if (capture.response !== undefined) rawCapture(capture.response)
  if (envelope.upstream !== undefined) {
    const upstream = object(envelope.upstream, "upstream")
    headers(upstream.headers)
    if (!(upstream.status === null || typeof upstream.status === "number")) throw new Error("Invalid reference upstream status")
    const body = object(upstream.body, "upstream body")
    if (body.type === "stream") events(body.events)
    else if (body.type === "bytes") rawBody(body.body)
    else if (body.type !== "none") throw new Error("Invalid reference upstream body type")
  }
}

/** Physical evidence, intentionally not an A/B schema projection or a success oracle. */
export async function readReferenceStorage(db: ReferenceDatabase, bucket: ReferenceBucket, limits = { maxObjects: 10_000, maxDecodedBytes: 256 * 1024 * 1024 }) {
  const columns = (await db.prepare("PRAGMA table_info(dump_records)").all<{ name: string }>()).results.map(row => row.name)
  if (!columns.includes("response_upstream_body_descriptor") || columns.includes("upstream_exchanges_descriptor")) throw new Error("Declared reference dump schema mismatch")
  const rawRows = (await db.prepare("SELECT * FROM dump_records ORDER BY key_id,id").all<Obj>()).results
  const files = (await db.prepare("SELECT * FROM spilled_files ORDER BY file_key").all<Obj>()).results
  const references = new Map<string, { type: Descriptor["type"]; keyId: string; id: string; ownerKind: string }>()
  const rows = rawRows.map(row => {
    const decoded = { ...row, meta: object(JSON.parse(String(row.meta_json)), "metadata"), request_body_descriptor: descriptor(row.request_body_descriptor), response_body_descriptor: descriptor(row.response_body_descriptor), response_upstream_body_descriptor: descriptor(row.response_upstream_body_descriptor) }
    headers(JSON.parse(String(row.request_headers_json)))
    if (row.response_headers_json !== null) headers(JSON.parse(String(row.response_headers_json)))
    if (decoded.meta.id !== row.id) throw new Error("Reference dump metadata identity mismatch")
    for (const [field, ownerKind] of [["request_body_descriptor", "dump-request"], ["response_body_descriptor", "dump-response"], ["response_upstream_body_descriptor", "dump-response-upstream"]] as const) {
      const ref = decoded[field]
      if (!ref) continue
      if (references.has(ref.key)) throw new Error(`Reference body has multiple owners: ${ref.key}`)
      references.set(ref.key, { type: ref.type, keyId: String(row.key_id), id: String(row.id), ownerKind })
    }
    return decoded
  })
  const listed: { key: string; size: number }[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) })
    listed.push(...page.objects)
    if (listed.length > limits.maxObjects) throw new Error("Reference readback object limit exceeded")
    if (!page.truncated) break
    if (!page.cursor || cursors.has(page.cursor)) throw new Error("Reference bucket pagination stalled")
    cursors.add(page.cursor); cursor = page.cursor
  }
  const listedKeys = new Set(listed.map(entry => entry.key))
  if (listedKeys.size !== listed.length) throw new Error("Duplicate reference bucket key")
  for (const key of references.keys()) if (!listedKeys.has(key)) throw new Error(`Reference body missing: ${key}`)
  let totalDecodedBytes = 0
  const objects: ReferencePhysicalObject[] = []
  const ownershipIssues: { key: string; issue: string }[] = []
  for (const entry of listed) {
    const objectBody = await bucket.get(entry.key)
    if (!objectBody) throw new Error(`Reference listed object missing: ${entry.key}`)
    const compressed = Buffer.from(await objectBody.arrayBuffer())
    if (compressed.length !== entry.size) throw new Error(`Reference compressed size mismatch: ${entry.key}`)
    const ref = references.get(entry.key)
    const decoded = entry.key.endsWith(".gz") ? gunzipSync(compressed, { maxOutputLength: Math.max(1, limits.maxDecodedBytes - totalDecodedBytes) }) : compressed
    totalDecodedBytes += decoded.length
    if (totalDecodedBytes > limits.maxDecodedBytes) throw new Error("Reference readback decoded byte limit exceeded")
    let json: unknown
    if (ref?.type === "events" || ref?.type === "capture") {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded))
      if (ref.type === "events") events(json)
      else captureEnvelope(json)
    }
    const file = files.find(value => value.file_key === entry.key)
    if (!file) ownershipIssues.push({ key: entry.key, issue: "unregistered_object" })
    else if (ref && (file.state !== "owned" || file.owner_kind !== ref.ownerKind || file.owner_key !== JSON.stringify([ref.keyId, ref.id]))) ownershipIssues.push({ key: entry.key, issue: "descriptor_owner_mismatch" })
    objects.push({ ...entry, ...(ref ? { type: ref.type, owner: ref } : {}), compressedSha256: sha(compressed), decodedBytes: decoded.length, decodedSha256: sha(decoded), decodedBase64: decoded.toString("base64"), ...(json === undefined ? {} : { json }) })
  }
  for (const file of files) if (!listedKeys.has(String(file.file_key))) ownershipIssues.push({ key: String(file.file_key), issue: "registered_object_missing" })
  const tables: Record<string, Obj[]> = {}
  const historyCounts = { responses_snapshots: 0, responses_items: 0 }
  for (const table of ["usage", "usage_requests", "performance_summary", "performance_buckets", "responses_snapshots", "responses_items"]) {
    const records = (await db.prepare(`SELECT * FROM ${table}`).all<Obj>()).results
    tables[table] = records
    if (table === "responses_snapshots" || table === "responses_items") historyCounts[table] = records.length
  }
  return { schema: "reference-native-dump-v1" as const, rows, files, objects, tables, historyCounts, ownershipIssues, compressedBytes: listed.reduce((sum, entry) => sum + entry.size, 0), decodedBytes: totalDecodedBytes }
}
