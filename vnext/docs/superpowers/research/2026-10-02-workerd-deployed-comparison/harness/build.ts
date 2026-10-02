import { builtinModules } from "node:module"
import { dirname, join, resolve } from "node:path"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { fileIdentity, sha, type FileIdentity } from "./manifest.ts"
import { declaredDependency, packagePath, type ResolutionEdge } from "./resolution.ts"
import { durableJson } from "./journal.ts"

type Obj = Record<string, unknown>
/** Bun's text lockfile permits trailing commas. Preserve string contents. */
export function parseLock(text: string): { packages: Obj } {
  let quoted = false, escaped = false, cleaned = ""
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ""
    if (quoted) {
      cleaned += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
    } else {
      if (char === '"') quoted = true
      if (char === "," && /^[\s]*[\]}]/.test(text.slice(i + 1))) continue
      cleaned += char
    }
  }
  const parsed: unknown = JSON.parse(cleaned)
  if (!parsed || typeof parsed !== "object" || !("packages" in parsed) || !parsed.packages || typeof parsed.packages !== "object") throw new Error("Invalid Bun lock packages")
  return parsed as { packages: Obj }
}
export function lockAgreement(a: Obj, b: Obj, name: string, version: string) {
  const entries = (packages: Obj) => Object.entries(packages).filter(([, entry]) => Array.isArray(entry) && entry[0] === `${name}@${version}`).map(([key, entry]) => ({ key, entry }))
  const left = entries(a), right = entries(b)
  if (!left.length || !right.length || JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`Third-party lock identity mismatch: ${name}@${version}`)
  return { name, version, lockEntrySha256: sha(JSON.stringify(left)) }
}
function packageOwner(path: string): { directory: string; name: string; version: string } {
  let directory = dirname(path)
  for (;;) {
    const pkgPath = join(directory, "package.json")
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string }
      if (pkg.name && pkg.version) return { directory, name: pkg.name, version: pkg.version }
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Resolved module lacks package owner: ${path}`)
    directory = parent
  }
}
export function workspaceExports(root: string) {
  const exports = new Map<string, string>()
  for (const directory of readdirSync(join(root, "vnext/packages"))) {
    const base = join(root, "vnext/packages", directory)
    if (!existsSync(join(base, "package.json"))) continue
    const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as { name: string; exports?: Record<string, string> }
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      if (typeof value !== "string" || !value.startsWith("./")) throw new Error(`Unsupported workspace export ${pkg.name}/${key}`)
      exports.set(pkg.name + (key === "." ? "" : key.slice(1)), (value.includes("*") ? resolve(base, value) : realpathSync(resolve(base, value))))
    }
  }
  return exports
}
export function resolveDeclaredImport(specifier: string, importer: string, root: string, candidate: string, declared?: { directory: string; range: string }) {
  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0] ?? specifier
  const owner = declared ?? declaredDependency(importer, name)
  const from = owner.directory.startsWith(root + "/") ? join(candidate, owner.directory.slice(root.length + 1)) : owner.directory
  if (from !== owner.directory) {
    const counterpart = declaredDependency(join(from, "__resolver__.ts"), name)
    if (counterpart.range !== owner.range) throw new Error(`Importer dependency edge differs ${name}`)
  }
  return { path: realpathSync(Bun.resolveSync(specifier, from)), edge: { name, from, packageJson: packagePath(name, from), optional: false } }
}
export async function matchedBuild(root: string, candidate: string, output: string, approvedFiles: FileIdentity[]) {
  root = realpathSync(root); candidate = realpathSync(candidate)
  const aLock = parseLock(readFileSync(join(root, "vnext/bun.lock"), "utf8"))
  const bLock = parseLock(readFileSync(join(candidate, "vnext/bun.lock"), "utf8"))
  const workspace = workspaceExports(root)
  const approved = new Map(approvedFiles.map(file => [realpathSync(file.path), file.sha256]))
  const thirdRoot = realpathSync(join(candidate, "vnext/node_modules/.bun"))
  const builtin = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])
  const records: { specifier: string; importer: string; resolved: string; package?: { name: string; version: string; lockEntrySha256: string }; edge?: ResolutionEdge; exception?: unknown }[] = []
  const consumed = new Map<string, FileIdentity>()
  let result: Awaited<ReturnType<typeof Bun.build>>
  try {
  result = await Bun.build({
    entrypoints: [join(root, "vnext/apps/platform-cloudflare/src/worker.ts")],
    target: "node", external: ["cloudflare:sockets"], naming: "worker.mjs", sourcemap: "external", outdir: output,
    plugins: [{ name: "frozen-import-only-resolver", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path === "cloudflare:sockets" || builtin.has(args.path)) return { path: args.path, external: true }
        let path: string
        let edge: ResolutionEdge | undefined
        let importException: unknown = null
        let workspacePath = workspace.get(args.path)
        if (!workspacePath) for (const [pattern, target] of workspace) {
          if (!pattern.includes("*")) continue
          const [prefix, suffix] = pattern.split("*")
          if (prefix !== undefined && suffix !== undefined && args.path.startsWith(prefix) && args.path.endsWith(suffix)) {
            workspacePath = realpathSync(target.replace("*", args.path.slice(prefix.length, args.path.length - suffix.length)))
            break
          }
        }
        if (workspacePath) { declaredDependency(args.importer, args.path.split("/").slice(0, 2).join("/")); path = workspacePath }
        else {
          if (/^@vibe-(?:core|llm)\//.test(args.path)) throw new Error(`Undeclared variant workspace export ${args.path}`)
          const bare = !args.path.startsWith(".") && !args.path.startsWith("/")
          const dependencyName = args.path.startsWith("@") ? args.path.split("/").slice(0, 2).join("/") : args.path.split("/")[0] ?? args.path
          let owner: { directory: string; range: string } | null = null
          let exception: unknown = null
          if (bare) {
            try { owner = declaredDependency(args.importer, dependencyName) } catch (error) {
              const scope = packageOwner(args.importer)
              if (scope.name !== "@reclaimprotocol/tls" || scope.version !== "0.1.2" || args.importer !== join(scope.directory, "lib/crypto/common.js") || !["@peculiar/asn1-cms", "@peculiar/asn1-rsa"].includes(args.path)) throw error
              const declarations = [root, candidate].map(source => declaredDependency(join(source, "vnext/packages/http/__resolver__.ts"), args.path))
              if (declarations.some(declaration => declaration.range !== "^2.3.14")) throw new Error("Published TLS exception lost exact http declaration")
              owner = { directory: scope.directory, range: "published-tls-0.1.2-manifest-omission" }
              exception = { ruling: "tls-common-js-two-imports-only", importer: fileIdentity(args.importer), importerPackage: fileIdentity(join(scope.directory, "package.json")), declarations: [root, candidate].map(source => fileIdentity(join(source, "vnext/packages/http/package.json"))) }
            }
          }
          if (bare && owner) {
            const resolved = resolveDeclaredImport(args.path, args.importer, root, candidate, owner)
            path = resolved.path; edge = resolved.edge
          } else path = realpathSync(Bun.resolveSync(args.path, dirname(args.importer || join(root, "vnext/apps/platform-cloudflare/src/worker.ts"))))
          importException = exception
        }
        const isSource = path.startsWith(join(root, "vnext") + "/") && !path.includes("/node_modules/")
        if (!isSource && !path.startsWith(thirdRoot + "/")) throw new Error(`Resolved module escaped variant/dependency roots: ${path}`)
        const identity = fileIdentity(path)
        if (approved.get(path) !== identity.sha256) throw new Error(`Resolved module lacks pre-build frozen identity: ${path}`)
        consumed.set(path, identity)
        const owner = !isSource ? packageOwner(path) : null
        records.push({ specifier: args.path, importer: args.importer, resolved: path, ...(edge ? { edge } : {}), ...(importException ? { exception: importException } : {}), ...(owner ? { package: lockAgreement(aLock.packages, bLock.packages, owner.name, owner.version) } : {}) })
        return { path }
      })
    } }],
  })
  } catch (error) {
    durableJson(join(dirname(output), "resolved-modules.json"), { completed: false, records, consumed: [...consumed.values()], error: String(error) }, true)
    throw error
  }
  durableJson(join(dirname(output), "resolved-modules.json"), { completed: result.success, options: { target: "node", external: ["cloudflare:sockets"], naming: "worker.mjs", sourcemap: "external" }, records, consumed: [...consumed.values()], logs: result.logs.map(log => String(log)) }, true)
  if (!result.success) throw new Error("Matched Bun build failed; inspect resolved-modules.json")
}
if (import.meta.main) {
  const [root, candidate, output, approved] = process.argv.slice(2)
  if (!root || !candidate || !output || !approved) throw new Error("build.ts requires root candidate output approved-inputs.json")
  await matchedBuild(root, candidate, output, JSON.parse(readFileSync(approved, "utf8")) as FileIdentity[])
}
