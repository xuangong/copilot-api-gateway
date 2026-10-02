// Reused from 2026-09-30-cfw-request-boundaries/harness/oracle.ts; see README provenance.
type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Obj : {}
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : []
const POLICY_REFUSAL_EXPLANATION = "Anthropic refused this request under an unspecified policy category."
export interface Expectation { variant?: "A" | "B"; upstream?: string; protocol: string; scenario: string; bytes: number; stream: boolean }
export function semantic(e: unknown): boolean {
  const v=obj(e), d=obj(v.delta)
  if (["response.output_text.delta", "response.refusal.delta", "response.function_call_arguments.delta"].includes(String(v.type))) return Boolean(v.delta)
  if (v.type === "content_block_delta") return Boolean(d.text || d.partial_json)
  return arr(v.choices).some(x => { const delta=obj(obj(x).delta); return Boolean(delta.content || delta.refusal || delta.tool_calls) })
}
export function oracle(status: number, events: unknown[], done: boolean, expected: Expectation, canonical?: { wireStream: boolean; failureRecorded?: boolean }) {
  let text="", refusal="", toolId="", toolName="", argumentsText="", terminal=false, failed=false, input: unknown, output: unknown, terminalCount=0
  const {protocol,scenario,bytes,stream}=expected
  const wireStream=canonical?.wireStream ?? stream
  let responseTextDelta="",responseRefusalDelta="",responseArgumentsDelta="",partialObserved=false,toolStarts=0,startedToolId="",policyRefusal=false,chatFinishReason=""
  let anySuccessTerminal=false
  for (const event of events) {
    const v=obj(event)
    const envelope=obj(v.response ?? v), policyError=obj(envelope.error)
    const acceptedPolicyEnvelope=expected.variant !== "A" && expected.upstream === "messages" && scenario === "refusal" && protocol === "responses" && envelope.status === "failed" && (!stream || v.type === "response.failed") && policyError.code === "invalid_prompt" && policyError.message === POLICY_REFUSAL_EXPLANATION
    if(acceptedPolicyEnvelope) policyRefusal=true
    if(semantic(v)) partialObserved=true
    if(v.type === "response.output_text.delta") responseTextDelta+=String(v.delta ?? "")
    if(v.type === "response.refusal.delta") responseRefusalDelta+=String(v.delta ?? "")
    if(v.type === "response.function_call_arguments.delta") responseArgumentsDelta+=String(v.delta ?? "")
    if(v.type === "response.output_item.added" && obj(v.item).type === "function_call") {toolStarts++;startedToolId=String(obj(v.item).call_id)}
    if ((v.error || ["error", "response.failed", "response.incomplete"].includes(String(v.type))) && !acceptedPolicyEnvelope) failed=true
    if(canonical && !stream && protocol === "responses" && ["failed", "incomplete"].includes(String(v.status))) failed=true
    if (protocol === "responses") {
      if (v.type === "response.completed" || v.type === "response.failed" || (!stream && v.object === "response")) {
        const r=stream ? obj(v.response) : v
        terminal=r.status === "completed" || acceptedPolicyEnvelope; terminalCount++
        const u=obj(r.usage); input=u.input_tokens; output=u.output_tokens
        for (const value of arr(r.output)) {
          const item=obj(value)
          if (item.type === "function_call") { toolId=String(item.call_id); toolName=String(item.name); argumentsText=String(item.arguments) }
          for (const value of arr(item.content)) { const part=obj(value); if(part.type === "output_text") text+=String(part.text ?? ""); if(part.type === "refusal") refusal+=String(part.refusal ?? "") }
        }
      }
    } else if (protocol === "chat") {
      const usage=obj(v.usage)
      if (usage.prompt_tokens !== undefined) { input=usage.prompt_tokens; output=usage.completion_tokens }
      for (const choice of arr(v.choices)) {
        const c=obj(choice), m=obj(stream ? c.delta : c.message)
        if(c.finish_reason) { terminal=true; terminalCount++; chatFinishReason=String(c.finish_reason) }
        text+=String(m.content ?? ""); refusal+=String(m.refusal ?? "")
        if(c.finish_reason === "content_filter" && !refusal && text === "BENCH_REFUSAL") {refusal=text;text=""}
        for(const value of arr(m.tool_calls)) {const t=obj(value), f=obj(t.function); toolId+=String(t.id ?? ""); toolName+=String(f.name ?? ""); argumentsText+=String(f.arguments ?? "")}
      }
    } else {
      if(!stream) {
        terminal=Boolean(v.stop_reason); terminalCount++
        const usage=obj(v.usage); input=usage.input_tokens; output=usage.output_tokens
        for(const value of arr(v.content)) {const b=obj(value); if(b.type === "text") text+=String(b.text ?? ""); if(b.type === "tool_use") {toolId=String(b.id);toolName=String(b.name);argumentsText=JSON.stringify(b.input)}}
        if(v.stop_reason === "refusal") {refusal=text;text=""}
      } else {
        if(v.type === "message_start") input=obj(obj(v.message).usage).input_tokens
        if(v.type === "content_block_start") {const b=obj(v.content_block); if(b.type === "tool_use") {toolId+=String(b.id);toolName+=String(b.name)}}
        if(v.type === "content_block_delta") {const d=obj(v.delta);text+=String(d.text ?? "");argumentsText+=String(d.partial_json ?? "")}
        if(v.type === "message_delta") {const usage=obj(v.usage);if(usage.input_tokens!==undefined) input=usage.input_tokens;if(usage.output_tokens!==undefined) output=usage.output_tokens;if(obj(v.delta).stop_reason === "refusal") {refusal=text;text=""}}
        if(v.type === "message_stop") {terminal=true;terminalCount++}
      }
    }
    if(terminal) anySuccessTerminal=true
  }
  const successTerminalObserved=anySuccessTerminal
  if(protocol === "chat" && stream) terminal=terminal && done
  const faulty=["failed","truncated","http503"].includes(scenario)
  const errors:string[]=[]
  if(faulty) {
    // Capture metadata can record a source failure before the egress adds its
    // wire error frame. This evidence is never available to the wire oracle.
    if(canonical?.failureRecorded) failed=true
    if(canonical) {
      // This fixed failure/truncation fixture never emits a success terminal.
      if(["failed", "truncated"].includes(scenario) && successTerminalObserved) errors.push("unexpected_captured_success_terminal")
    } else if(successTerminalObserved && status >=200 && status<300) errors.push("false_success_on_fault")
    if(scenario === "http503") {if(status !== 503) errors.push("wrong_upstream_http_status")}
    else if(!wireStream) {if(status !== 502) errors.push("wrong_upstream_json_fault_status")}
    else {
      if(status !== 200) errors.push("partial_fault_not_streamed")
      if(!partialObserved) errors.push("missing_partial_output_before_fault")
    }
    if(scenario === "failed" && (wireStream || canonical) && !failed) errors.push("missing_explicit_failure_event")
    return {ok:errors.length===0, errors, classification: status>=400 ? "http_failure" : canonical?.failureRecorded ? "captured_failure_metadata" : failed ? "explicit_failure" : terminal ? "false_success" : "truncated_no_terminal", terminal, usage: {input,output}}
  }
  if(status<200 || status>=300) errors.push(`http_${status}`)
  if(failed) errors.push("unexpected_failure")
  if(!terminal) errors.push("missing_success_terminal")
  if(terminalCount!==1) errors.push(`terminal_count_${terminalCount}`)
  if(scenario === "tool") {
    if(toolId!=="call_bench" || toolName!=="weather") errors.push("tool_identity_mismatch")
    try {if(obj(JSON.parse(argumentsText)).city!=="Paris") errors.push("tool_arguments_mismatch")} catch {errors.push("invalid_tool_arguments")}
  } else if(scenario === "refusal") {
    if(protocol === "chat" && !["stop", "content_filter"].includes(chatFinishReason)) errors.push("invalid_refusal_finish_reason")
    if(policyRefusal && text === "BENCH_REFUSAL") refusal="BENCH_REFUSAL"
    if(protocol === "chat" && expected.upstream === "messages" && refusal === POLICY_REFUSAL_EXPLANATION && text === "BENCH_REFUSAL") refusal="BENCH_REFUSAL"
    if(refusal!=="BENCH_REFUSAL") errors.push("refusal_semantics_missing")
  } else if(text!==`BENCH_OK:${bytes}`) errors.push("output_or_history_length_mismatch")
  if(stream && protocol === "responses") {
    if(scenario === "tool") {
      if(responseArgumentsDelta!==argumentsText || toolStarts!==1 || startedToolId!=="call_bench") errors.push("tool_delta_mismatch")
    } else if(scenario === "refusal") {if(policyRefusal ? responseTextDelta!==text || text!=="BENCH_REFUSAL" : responseRefusalDelta!==refusal) errors.push("refusal_delta_mismatch")}
    else if(responseTextDelta!==text) errors.push("text_delta_mismatch")
  }
  if(input!==7 || output!==3) errors.push("usage_mismatch")
  return {ok:errors.length===0,errors,classification:errors.length ? "semantic_mismatch" : scenario === "refusal" ? "expected_refusal" : "success",terminal,usage:{input,output}}
}
