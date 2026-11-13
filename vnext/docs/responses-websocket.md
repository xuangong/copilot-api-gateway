# Responses WebSocket interruption

The shared Bun/Workers session accepts flat `response.create` requests and the
Codex CLI 0.169.0 interruption frame:

```json
{"type":"response.interrupt","response_id":"resp_…","mode":"discard_partial_items"}
```

For a matching active response, the gateway sends
`response.interrupt.accepted` with the same `response_id`, cancels upstream
generation, and emits one `response.completed`. Its output contains only items
closed by `response.output_item.done`, excluding items marked incomplete or
still in progress. Added items and partial text/tool-argument deltas are not
saved. The terminal does not invent token usage.

The completed subset follows the normal affinity and snapshot pipeline.
`store:false` continuation remains private to the socket; configured durable
storage uses the same filtered output. A subsequent create waits for cleanup
before resolving `previous_response_id`. Failed cleanup closes the session.
Disconnects remain cancellations and do not manufacture a completion.

An interrupt crossing a selected completion preserves that completion and its
usage. Repeated interrupts and a late interrupt for the latest delivered
completion are acknowledged without sending another terminal or cancelling a
different response. Unknown IDs receive `response.interrupt.failed`; malformed
IDs, unsupported modes and additional interruption fields receive protocol
errors. These error codes are gateway choices, not a claim of full OpenAI
WebSocket protocol support.

Client contract: [Codex rust-v0.169.0 WebSocket reader](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/codex-api/src/endpoint/responses_websocket.rs).
Regression coverage uses real SQLite and native Bun/workerd sockets, replaying
the client frame. It is not a Windows CLI end-to-end test.
