/**
 * Opt-in trace for the server-tool shim's ReAct path.
 *
 * The shim spans two dispatches — the orchestrator turn that decides to call
 * the tool, and the separate backend call the gateway makes on its behalf —
 * and a failure in either surfaces to the client the same way: a terminal
 * `image_generation_call` with `status:"failed"`. That collapses "the model
 * never called the tool", "no upstream serves the image model", and "the
 * backend rejected the call" into one indistinguishable symptom. These traces
 * separate them.
 *
 * Off unless `SERVER_TOOL_TRACE=1`, so nothing is emitted in normal operation.
 * Fields are shim/routing metadata only — tool names, model ids, upstream ids,
 * status codes, byte counts. Never prompts, image bytes, or arguments.
 */

/** Env reads are defensive: workerd exposes `process.env` under nodejs_compat,
 *  but not every host does, and this must never throw on a hot path. */
const traceEnabled = (): boolean => {
  try {
    return process.env.SERVER_TOOL_TRACE === '1'
  } catch {
    return false
  }
}

const enabled = traceEnabled()

export const serverToolTrace = (evt: string, fields: Record<string, unknown>): void => {
  if (!enabled) return
  try {
    console.log(JSON.stringify({ evt: `[server-tool] ${evt}`, ...fields }))
  } catch {
    // A trace must never break the request it is describing.
  }
}
