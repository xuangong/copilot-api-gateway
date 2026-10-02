import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"

export interface ResolutionEdge { name: string; from: string; packageJson: string | null; optional: boolean }
export function packagePath(name: string, from: string): string {
  // Inspect the physical resolution chain rather than Node/Bun's cached resolver.
  let directory = realpathSync(from)
  for (;;) {
    const path = join(directory, "node_modules", name, "package.json")
    if (existsSync(path)) return realpathSync(path)
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Cannot resolve installed package ${name} from ${from}`)
    directory = parent
  }
}
export function verifyResolution(edges: ResolutionEdge[]) {
  for (const edge of edges) {
    let actual: string | null = null
    try { actual = packagePath(edge.name, edge.from) } catch (error) { if (!edge.optional) throw error }
    if (actual !== edge.packageJson) throw new Error(`Resolution drift: ${edge.name} from ${edge.from}`)
  }
}
export function declaredDependency(importer: string, name: string) {
  let directory = dirname(importer)
  let pkg: { name?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> } = {}
  for (;;) {
    if (existsSync(join(directory, "package.json"))) {
      pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as typeof pkg
      if (pkg.name) break
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Importer lacks package scope ${importer}`)
    directory = parent
  }
  const range = pkg.dependencies?.[name] ?? pkg.optionalDependencies?.[name] ?? pkg.peerDependencies?.[name]
  if (!range && pkg.name !== name) throw new Error(`Undeclared dependency ${name} in ${directory}`)
  return { directory, range: range ?? "self" }
}
