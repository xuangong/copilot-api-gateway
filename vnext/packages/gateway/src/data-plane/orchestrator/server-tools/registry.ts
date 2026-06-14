/**
 * Server-tool plugin registry — Week 4b-1 scaffold.
 *
 * Module-level registry keyed by plugin name. Plugins self-register at import
 * time (Week 4b-3/4b-4 ports add web-search and image-generation entries).
 * The orchestrator iterates plugins to build per-request `ActiveServerTool`
 * descriptors before dispatching the upstream call.
 *
 * Why module singleton (vs DI container): plugins are pure code, not config —
 * the binding-resolver / flag system decides per-request which ones run.
 * The registry just exposes the catalog.
 */
import type { ServerToolPlugin } from './types.ts'

const PLUGINS: Map<string, ServerToolPlugin<unknown, unknown>> = new Map()

export const registerServerToolPlugin = (plugin: ServerToolPlugin<unknown, unknown>): void => {
  if (PLUGINS.has(plugin.name)) {
    throw new Error(`ServerToolPlugin "${plugin.name}" already registered`)
  }
  PLUGINS.set(plugin.name, plugin)
}

export const listServerToolPlugins = (): readonly ServerToolPlugin<unknown, unknown>[] =>
  Array.from(PLUGINS.values())

export const getServerToolPlugin = (name: string): ServerToolPlugin<unknown, unknown> | undefined =>
  PLUGINS.get(name)

/** Test-only — clears the registry so unit tests can start from empty state. */
export const _resetServerToolRegistry = (): void => {
  PLUGINS.clear()
}
