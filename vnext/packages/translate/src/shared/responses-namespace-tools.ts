import type { ResponsesPayload } from "@vibe-llm/protocols/responses"
import { TranslatorValidationError } from "../errors"
import { projectResponsesTools } from "./responses-tools"

type Tool = NonNullable<ResponsesPayload["tools"]>[number]
type CallableKind = "function" | "custom"
interface ToolIdentity { namespace: string; name: string; kind: CallableKind }
export interface ResponsesToolMapping {
  readonly targetToSource: ReadonlyMap<string, ToolIdentity>
  readonly customToolNames: readonly string[]
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const fail = (message: string, field: string): never => { throw new TranslatorValidationError(message, field) }
const nonempty = (value: unknown, field: string): string =>
  typeof value === "string" && value.length > 0 ? value : fail("Cannot translate an empty or malformed tool identity", field)
const identityKey = (namespace: string, name: string) => JSON.stringify([namespace, name])

/** Request-local, reversible names for targets that only accept flat tools. */
export function prepareResponsesTools(source: ResponsesPayload): { payload: ResponsesPayload; mapping: ResponsesToolMapping; inputBoundaries: ReadonlySet<number> } {
  const input = Array.isArray(source.input) ? source.input : []
  const inventories: Tool[][] = [source.tools ?? []]
  for (const item of input) {
    if (item.type !== "additional_tools" && item.type !== "tool_search_output") continue
    if (!Array.isArray(item.tools)) fail("Cannot translate malformed historical tool inventory", "input")
    inventories.push(item.tools as Tool[])
  }
  const reserved = new Set<string>()
  for (const tools of inventories) for (const tool of tools) {
    if (!record(tool)) fail("Cannot translate malformed tool declaration", "tools")
    if ((tool.type === "function" || tool.type === "custom") && tool.namespace === undefined && typeof tool.name === "string") reserved.add(tool.name)
  }
  for (const item of input) {
    if ((item.type === "function_call" || item.type === "custom_tool_call") && item.namespace === undefined && typeof item.name === "string") reserved.add(item.name)
  }
  const sourceToTarget = new Map<string, string>()
  const targetToSource = new Map<string, ToolIdentity>()
  const nextSuffix = new Map<string, number>()
  const allocate = (namespace: string, name: string, kind: CallableKind): string => {
    const key = identityKey(namespace, name)
    const existing = sourceToTarget.get(key)
    if (existing !== undefined) {
      if (targetToSource.get(existing)?.kind !== kind) fail("Cannot translate ambiguous namespace callable kinds", "tools")
      return existing
    }
    // Chat Completions names are at most 64 ASCII characters:
    // https://platform.openai.com/docs/api-reference/chat/create#chat_create-tools
    const prefix = `${namespace.slice(0, 64)}_`.slice(0, 64)
    const base = `${prefix}${name.slice(0, 64 - prefix.length)}`.replace(/[^a-zA-Z0-9_-]/g, "_")
    let suffix = nextSuffix.get(base) ?? 1
    let candidate: string
    do {
      const ending = suffix === 1 ? "" : `_${suffix}`
      candidate = `${base.slice(0, 64 - ending.length)}${ending}`
      suffix++
    } while (reserved.has(candidate))
    nextSuffix.set(base, suffix)
    reserved.add(candidate)
    sourceToTarget.set(key, candidate)
    targetToSource.set(candidate, { namespace, name, kind })
    return candidate
  }
  const declared = new Map<string, Array<{ type: CallableKind; name: string }>>()
  const tools: Tool[] = []
  const addCallable = (tool: Tool, namespace: string, description?: string) => {
    if (tool.type !== "function" && tool.type !== "custom") fail("Cannot translate non-callable namespace child", "tools")
    if (tool.namespace !== undefined && tool.namespace !== namespace) fail("Cannot translate conflicting tool namespaces", "tools")
    const kind = tool.type as CallableKind
    const name = allocate(namespace, nonempty(tool.name, "tools"), kind)
    const children = declared.get(namespace) ?? []
    children.push({ type: kind, name })
    declared.set(namespace, children)
    const { namespace: _namespace, ...rest } = tool
    tools.push({ ...rest, name, ...(description ? { description: tool.description ? `${description}\n\n${tool.description}` : description } : {}) })
  }
  for (const inventory of inventories) for (const tool of inventory) {
    if (tool.type === "namespace") {
      const namespace = nonempty(tool.name, "tools")
      const children = Array.isArray(tool.tools) ? tool.tools : fail("Cannot translate malformed namespace children", "tools")
      if (!declared.has(namespace)) declared.set(namespace, [])
      for (const child of children) {
        if (!record(child)) fail("Cannot translate malformed namespace child", "tools")
        addCallable(child as Tool, namespace, typeof tool.description === "string" ? tool.description : undefined)
      }
    } else if ((tool.type === "function" || tool.type === "custom") && tool.namespace !== undefined) {
      addCallable(tool, nonempty(tool.namespace, "tools"))
    } else tools.push(tool)
  }
  const inputBoundaries = new Set<number>()
  let inputIndex = 0
  const flattenedInput = input.flatMap(item => {
    // Inventories carry turn boundaries even though flat targets cannot represent them.
    if (item.type === "additional_tools" || item.type === "tool_search_output") {
      inputBoundaries.add(inputIndex)
      return []
    }
    inputIndex++
    if ((item.type !== "function_call" && item.type !== "custom_tool_call") || item.namespace === undefined) return [item]
    const { namespace, ...rest } = item
    return [{ ...rest, name: allocate(nonempty(namespace, "input"), nonempty(item.name, "input"), item.type === "function_call" ? "function" : "custom") }]
  })
  const selector = (value: unknown): unknown => {
    const choice = record(value)
    if (!choice || (choice.type !== "function" && choice.type !== "custom")) return value
    if (Object.keys(choice).some(key => key !== "type" && key !== "name" && key !== "namespace")) fail("Cannot translate tool selector extensions", "tool_choice")
    const name = nonempty(choice.name, "tool_choice")
    let target: string | undefined
    if (choice.namespace !== undefined) {
      const namespace = nonempty(choice.namespace, "tool_choice")
      target = sourceToTarget.get(identityKey(namespace, name))
      if (!declared.get(namespace)?.some(child => child.name === target && child.type === choice.type)) fail("Tool selector requires a matching namespace callable declaration", "tool_choice")
    } else if (!tools.some(tool => tool.name === name && !targetToSource.has(name))) {
      const matches = [...targetToSource].filter(([, identity]) => identity.kind === choice.type
        && (name === `${identity.namespace}.${identity.name}` || name === `${identity.namespace}__${identity.name}`)
        && declared.get(identity.namespace)?.some(child => child.name === sourceToTarget.get(identityKey(identity.namespace, identity.name)) && child.type === choice.type))
      if (matches.length > 1) fail("Cannot select ambiguous qualified tool", "tool_choice")
      target = matches[0]?.[0]
    }
    if (target === undefined) return value
    const { namespace: _namespace, ...rest } = choice
    return { ...rest, name: target }
  }
  let choice: unknown = source.tool_choice
  const restriction = record(choice)
  if (restriction?.type === "allowed_tools" && Array.isArray(restriction.tools)) {
    choice = { ...restriction, tools: restriction.tools.flatMap(value => {
      const selected = record(value)
      if (selected?.type !== "namespace") return [selector(value)]
      if (Object.keys(selected).some(key => key !== "type" && key !== "name")) fail("Cannot translate namespace selector extensions", "tool_choice")
      const children = declared.get(nonempty(selected.name, "tool_choice"))
      if (!children) fail("Cannot select undeclared namespace", "tool_choice")
      return children
    }) }
  } else choice = selector(choice)
  const payload = { ...source,
    ...(source.tools == null && inventories.length === 1 ? {} : { tools }),
    ...(choice === undefined ? {} : { tool_choice: choice }),
    ...(Array.isArray(source.input) ? { input: flattenedInput } : {}),
  } as ResponsesPayload
  const selected = projectResponsesTools(payload)
  return { inputBoundaries, payload: { ...payload, tools: selected.tools, tool_choice: selected.choice }, mapping: {
    targetToSource,
    customToolNames: Object.freeze((selected.tools ?? []).filter(tool => tool.type === "custom").map(tool => tool.name).filter((name): name is string => typeof name === "string")),
  } }
}

function restoreItem(value: unknown, mapping: ResponsesToolMapping): unknown {
  const item = record(value)
  if (!item || (item.type !== "function_call" && item.type !== "custom_tool_call") || item.namespace !== undefined || typeof item.name !== "string") return value
  const identity = mapping.targetToSource.get(item.name)
  return identity ? { ...item, namespace: identity.namespace, name: identity.name } : value
}

export function restoreResponsesToolBody(value: unknown, mapping: ResponsesToolMapping | undefined): unknown {
  const body = record(value)
  if (!mapping?.targetToSource.size || !body || !Array.isArray(body.output)) return value
  return { ...body, output: body.output.map(item => restoreItem(item, mapping)) }
}

export async function* restoreResponsesToolEvents(events: AsyncIterable<unknown>, mapping: ResponsesToolMapping | undefined): AsyncIterable<unknown> {
  const items = new Map<string, string>()
  for await (const value of events) {
    const event = record(value)
    if (!mapping?.targetToSource.size || !event) { yield value; continue }
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      const item = restoreItem(event.item, mapping)
      const call = record(item)
      if (item !== event.item && call?.type === "function_call" && typeof call.id === "string" && typeof call.name === "string") items.set(call.id, call.name)
      yield { ...event, item }
    } else if (event.type === "response.function_call_arguments.done") {
      const name = typeof event.item_id === "string" ? items.get(event.item_id) : undefined
      yield name === undefined ? value : { ...event, name }
    } else if (event.response !== undefined) {
      yield { ...event, response: restoreResponsesToolBody(event.response, mapping) }
    } else yield value
  }
}
