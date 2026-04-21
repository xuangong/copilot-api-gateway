export function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
      c.close()
    },
  })
}

// Anthropic message_start + delta sequence (cumulative)
export function anthropicStream(args: {
  inputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  outputDeltas: number[]   // cumulative values
}): ReadableStream<Uint8Array> {
  const events: unknown[] = [
    { type: "message_start", message: { usage: {
      input_tokens: args.inputTokens,
      cache_read_input_tokens: args.cacheReadTokens ?? 0,
      cache_creation_input_tokens: args.cacheCreationTokens ?? 0,
    } } },
    ...args.outputDeltas.map((n) => ({ type: "message_delta", usage: { output_tokens: n } })),
    { type: "message_stop" },
  ]
  return sseStream(events)
}

// OpenAI Chat Completions stream end-frame usage
export function openaiChatStream(args: {
  contentChunks: string[]
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
}): ReadableStream<Uint8Array> {
  const events: unknown[] = args.contentChunks.map((c) => ({
    choices: [{ delta: { content: c } }],
  }))
  if (args.promptTokens != null) {
    events.push({
      choices: [],
      usage: {
        prompt_tokens: args.promptTokens,
        completion_tokens: args.completionTokens ?? 0,
        total_tokens: (args.promptTokens) + (args.completionTokens ?? 0),
        ...(args.cachedTokens != null && {
          prompt_tokens_details: { cached_tokens: args.cachedTokens },
        }),
      },
    })
  }
  return sseStream(events)
}

// Responses /v1/responses response.completed
export function responsesStream(args: {
  textDeltas: string[]
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
}): ReadableStream<Uint8Array> {
  const events: unknown[] = [
    { type: "response.created" },
    ...args.textDeltas.map((t) => ({ type: "response.output_text.delta", delta: t })),
    { type: "response.completed", response: { usage: {
      input_tokens: args.inputTokens ?? 0,
      output_tokens: args.outputTokens ?? 0,
      ...(args.cachedTokens != null && {
        input_tokens_details: { cached_tokens: args.cachedTokens },
      }),
    } } },
  ]
  return sseStream(events)
}
