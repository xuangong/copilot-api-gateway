import { TranslatorValidationError } from '../../errors.ts'
import { imagePart, type AgentMessagePart, type AgentMessageTarget } from './agent-message.ts'

/**
 * Codex injects client context (the `/goal` objective, companion pages, ...) as
 * `function_call_output` items that carry a `name` but no `call_id`: they
 * answer no function call. Translated targets cannot express such a result, so
 * it is lowered to a user message wrapped in `<external_{name}>` markers, the
 * same representation Codex sends when `untrusted_as_tool_output` is off.
 * Adapted from reference copilot-gateway 730f2dcad (#739).
 */
export function isStandaloneToolOutput(item: { type?: string; call_id?: unknown }): boolean {
  return item.type === 'function_call_output' && item.call_id == null
}

export function standaloneToolOutputContent(
  value: object,
  path: string,
  target: AgentMessageTarget,
): AgentMessagePart[] {
  const item = value as { name?: unknown; output?: unknown }
  if (typeof item.name !== 'string' || item.name === '') {
    throw new TranslatorValidationError('A function call output without a call_id requires a name.', `${path}.name`)
  }
  const open = `<external_${item.name}>`
  const close = `</external_${item.name}>`
  const parts: AgentMessagePart[] = [{ type: 'input_text', text: open }]
  const pushText = (text: string) => {
    const last = parts[parts.length - 1]
    if (last?.type === 'input_text') last.text += text
    else parts.push({ type: 'input_text', text })
  }
  if (typeof item.output === 'string') {
    pushText(item.output)
  } else if (Array.isArray(item.output)) {
    for (const [index, raw] of item.output.entries()) {
      const part = raw as Record<string, unknown> | null
      const partPath = `${path}.output[${index}]`
      if ((part?.type === 'input_text' || part?.type === 'output_text') && typeof part.text === 'string') pushText(part.text)
      else if (part?.type === 'input_image') parts.push(imagePart(part, partPath, target))
      else throw new TranslatorValidationError(`Cannot translate unsupported standalone tool output content at ${partPath}`, partPath)
    }
  }
  pushText(close)
  return parts
}
