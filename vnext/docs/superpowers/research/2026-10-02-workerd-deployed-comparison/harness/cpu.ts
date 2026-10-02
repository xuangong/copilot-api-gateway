export interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number } }[]
  samples?: number[]
  timeDeltas?: number[]
  startTime: number
  endTime: number
}

export function cpuSummary(profile: CpuProfile, count: number) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const buckets = new Map<number, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  let sampledNonIdleUs = 0
  let sampledIdleUs = 0
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]
    if (id === undefined) continue
    const duration = deltas[i] ?? 0
    const node = nodes.get(id)
    if (node?.callFrame.functionName === "(idle)") sampledIdleUs += duration
    else sampledNonIdleUs += duration
    buckets.set(id, (buckets.get(id) ?? 0) + duration)
  }
  return {
    requests: count,
    wallWindowUs: profile.endTime - profile.startTime,
    sampledNonIdleUs,
    sampledIdleUs,
    sampledNonIdleUsPerRequest: sampledNonIdleUs / count,
    samples: samples.length,
    top: [...buckets].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, selfUs]) => ({ ...nodes.get(id)?.callFrame, selfUs })),
    boundary: "V8 sampled time in the gateway isolate, including background settlement; this is not billed CPU or process CPU. Local D1, host upstream and client work are outside this profile.",
  }
}
