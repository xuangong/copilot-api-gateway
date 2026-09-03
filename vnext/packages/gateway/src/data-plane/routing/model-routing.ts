export interface ModelRoutingHint {
  upstreamPin?: string
  bareModel: string
}

export function parseModelRouting(model: string): ModelRoutingHint {
  const slash = model.indexOf('/')
  if (slash <= 0) return { bareModel: model }
  const prefix = model.slice(0, slash)
  if (!prefix.startsWith('up_')) return { bareModel: model }
  return { upstreamPin: prefix, bareModel: model.slice(slash + 1) }
}
