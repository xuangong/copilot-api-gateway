import type { ResponsesAPIResponse } from "~/services/responses"

/**
 * Synthesize a standards-compliant Responses-API SSE stream from a
 * non-streaming ResponsesAPIResponse. Used by the web_search intercept
 * path: upstream is always non-stream, but if the client asked for
 * streaming we still owe them a proper event sequence — including the
 * web_search_call items (in_progress → searching → completed) that the
 * interceptor prepended to the output array.
 *
 * Emits, in order:
 *   1. response.created (status=in_progress)
 *   2. response.in_progress
 *   3. For each output item:
 *        - message:
 *            response.output_item.added (status=in_progress)
 *            response.content_part.added
 *            response.output_text.delta (full text in a single delta)
 *            response.output_text.done
 *            response.content_part.done
 *            response.output_item.done
 *        - web_search_call:
 *            response.output_item.added (status=in_progress)
 *            response.web_search_call.in_progress
 *            response.web_search_call.searching
 *            response.web_search_call.completed (or .failed)
 *            response.output_item.done (status=completed|failed)
 *        - function_call:
 *            response.output_item.added (status=in_progress)
 *            response.function_call_arguments.delta (full args in one delta)
 *            response.function_call_arguments.done
 *            response.output_item.done
 *   4. response.completed (with full final response)
 *
 * Sequence numbers monotonic; data: [DONE] terminator at the end so
 * existing OpenAI SDK consumers close cleanly.
 */
export function synthResponsesSSE(
  finalResponse: ResponsesAPIResponse,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let seq = 0
      const emit = (type: string, data: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
        )
      }

      // Clone a status=in_progress view of the final response for the
      // created/in_progress lifecycle events.
      const inProgressView: ResponsesAPIResponse = {
        ...finalResponse,
        status: "in_progress",
        output: [],
        output_text: "",
      }

      emit("response.created", {
        type: "response.created",
        response: inProgressView,
        sequence_number: seq++,
      })
      emit("response.in_progress", {
        type: "response.in_progress",
        response: inProgressView,
        sequence_number: seq++,
      })

      const output = Array.isArray(finalResponse.output) ? finalResponse.output : []
      for (let i = 0; i < output.length; i++) {
        const item = output[i] as { type?: string; [k: string]: unknown }
        const outputIndex = i

        if (item.type === "web_search_call") {
          const wsItem = item as {
            type: "web_search_call"
            id: string
            status: "completed" | "failed"
            action: { type: "search"; query: string }
          }
          const inProgressItem = { ...wsItem, status: "in_progress" as const }
          emit("response.output_item.added", {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: inProgressItem,
            sequence_number: seq++,
          })
          emit("response.web_search_call.in_progress", {
            type: "response.web_search_call.in_progress",
            output_index: outputIndex,
            item_id: wsItem.id,
            sequence_number: seq++,
          })
          emit("response.web_search_call.searching", {
            type: "response.web_search_call.searching",
            output_index: outputIndex,
            item_id: wsItem.id,
            sequence_number: seq++,
          })
          const terminalEvent =
            wsItem.status === "failed"
              ? "response.web_search_call.failed"
              : "response.web_search_call.completed"
          emit(terminalEvent, {
            type: terminalEvent,
            output_index: outputIndex,
            item_id: wsItem.id,
            sequence_number: seq++,
          })
          emit("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item: wsItem,
            sequence_number: seq++,
          })
          continue
        }

        if (item.type === "message") {
          const msg = item as {
            type: "message"
            id: string
            role: "assistant"
            status: "completed"
            content: Array<{ type: "output_text"; text: string; annotations: unknown[] }>
          }
          const fullText = msg.content?.[0]?.text ?? ""
          const inProgressItem = {
            ...msg,
            status: "in_progress" as const,
            content: [] as typeof msg.content,
          }
          emit("response.output_item.added", {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: inProgressItem,
            sequence_number: seq++,
          })
          emit("response.content_part.added", {
            type: "response.content_part.added",
            item_id: msg.id,
            output_index: outputIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
            sequence_number: seq++,
          })
          if (fullText.length > 0) {
            emit("response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: msg.id,
              output_index: outputIndex,
              content_index: 0,
              delta: fullText,
              sequence_number: seq++,
            })
          }
          emit("response.output_text.done", {
            type: "response.output_text.done",
            item_id: msg.id,
            output_index: outputIndex,
            content_index: 0,
            text: fullText,
            sequence_number: seq++,
          })
          emit("response.content_part.done", {
            type: "response.content_part.done",
            item_id: msg.id,
            output_index: outputIndex,
            content_index: 0,
            part: { type: "output_text", text: fullText, annotations: [] },
            sequence_number: seq++,
          })
          emit("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item: msg,
            sequence_number: seq++,
          })
          continue
        }

        if (item.type === "function_call") {
          const fc = item as {
            type: "function_call"
            id: string
            call_id: string
            name: string
            arguments: string
            status: "completed"
          }
          const inProgressItem = { ...fc, arguments: "", status: "in_progress" as const }
          emit("response.output_item.added", {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: inProgressItem,
            sequence_number: seq++,
          })
          if (fc.arguments) {
            emit("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              item_id: fc.id,
              output_index: outputIndex,
              delta: fc.arguments,
              sequence_number: seq++,
            })
          }
          emit("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            item_id: fc.id,
            output_index: outputIndex,
            arguments: fc.arguments,
            name: fc.name,
            sequence_number: seq++,
          })
          emit("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item: fc,
            sequence_number: seq++,
          })
          continue
        }

        // Unknown item type — emit a best-effort added/done pair so
        // sequence numbers stay aligned.
        emit("response.output_item.added", {
          type: "response.output_item.added",
          output_index: outputIndex,
          item,
          sequence_number: seq++,
        })
        emit("response.output_item.done", {
          type: "response.output_item.done",
          output_index: outputIndex,
          item,
          sequence_number: seq++,
        })
      }

      emit("response.completed", {
        type: "response.completed",
        response: { ...finalResponse, status: "completed" },
        sequence_number: seq++,
      })

      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
}
