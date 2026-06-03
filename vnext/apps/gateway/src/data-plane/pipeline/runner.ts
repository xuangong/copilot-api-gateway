/**
 * Pipeline runner — IR-level transforms ordered by stage.
 *
 * Each transform mutates IRRequest in place (or returns a new one) and
 * may emit flags consumed by downstream interceptors. Stages run in
 * fixed order; within a stage, transforms run in registration order.
 *
 * Week 3c skeleton: contract + runner. Concrete transforms (compress-
 * inline-images, token-count, cache-breakpoint) port in Week 3d/4.
 */
import type { IRRequest } from '@vnext/protocols/ir'

export type PipelineStage = 'pre-binding' | 'post-binding' | 'pre-dispatch'

export interface IRTransform {
  /** Unique name for tracing / dedup. */
  readonly name: string
  /** Stage at which this transform runs. */
  readonly stage: PipelineStage
  /** Predicate — return false to skip. */
  when?(req: IRRequest): boolean
  /** Mutate (or return new) IRRequest; may flip flags on req.meta.flags. */
  apply(req: IRRequest): IRRequest | Promise<IRRequest>
}

export interface PipelineRunner {
  register(transform: IRTransform): void
  run(stage: PipelineStage, req: IRRequest): Promise<IRRequest>
}

export function createPipelineRunner(): PipelineRunner {
  const byStage: Record<PipelineStage, IRTransform[]> = {
    'pre-binding': [],
    'post-binding': [],
    'pre-dispatch': [],
  }
  return {
    register(t: IRTransform): void {
      byStage[t.stage].push(t)
    },
    async run(stage: PipelineStage, req: IRRequest): Promise<IRRequest> {
      let cur = req
      for (const t of byStage[stage]) {
        if (t.when && !t.when(cur)) continue
        cur = await t.apply(cur)
      }
      return cur
    },
  }
}
