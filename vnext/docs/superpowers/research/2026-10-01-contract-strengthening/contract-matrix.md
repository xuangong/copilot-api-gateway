# Request boundary contract matrix

This batch revisits the preceding stage and interceptor changes, rather than treating their completed status as a reason to skip their contracts. The design and implementation checklist are in the [spec](../../specs/2026-10-01-contract-strengthening.md) and [plan](../../plans/2026-10-01-contract-strengthening.md). Final acceptance is recorded separately in the [qualification report](qualification.md).

## Extension boundaries

| Boundary | Accepted input and guaranteed output | Authority and owner | Failure and validation |
| --- | --- | --- | --- |
| Parse and prepare | Raw endpoint input becomes a parsed payload, then an explicit preprocessing result: early response or payload plus exact `TExtra` | Endpoint hook owns routing preparation; the generic kit retains ordering | Parse/preprocess errors keep their endpoint envelope; early rejection precedes quota and inference |
| Prepared observation | Borrowed top-level readonly payload and compact decision; synchronous `undefined` return | Observer can inspect or synchronously reject preparation | Type checks reject async/broad-void callbacks; observer errors do not detach or start inference |
| Prepare to execute | Ready capability carries the original prepared context and exact extra | Module-private capability binds one original runner and is consumed before invocation | Repeated/concurrent execution rejects, including after failure; no replacement inputs |
| Request normalization | Mutable payload and readonly flag view; synchronous `undefined` return | Existing `beforeRequest` adapter delegates once per chain entry; all 21 migrated normalizers retain placement | Throws reject before delegation; tool-loop reentry is preserved; no runtime sandbox or payload copy |
| Translated result | Explicit source domain and one supported translated producer domain, plus independent body/event adapters | Translation owns mapping; the existing producer owner owns disposal | Shared producer type admits Chat Completions, Messages and Responses; runtime guard still rejects malformed foreign values; native/source Gemini remains valid |
| Hosted-tool private state | Typed search v1 payload; reader and writer are separate interfaces; new write/dispose methods return `undefined` | Plugin only reads; materializer only writes; the full lazy hosted response owns default state and disposal | New capabilities reject async/broad-void implementations; borrowed values, including sparse array positions, are decoded at the boundary; missing/malformed history uses the established fallback; closed access cannot resume |
| Stream and continuation | Existing execution facts, final metadata and optional projection receipts | Existing response/turn owners retain terminal outcome, transport and continuation authority | Cleanup failure is retained separately from metadata settlement; failure cannot manufacture a successful terminal response |

## Reference strengths adopted deliberately

The inspected reference checkout is `1d7dcd923e260e425120cca0c7a240e93720af27`. The following are source observations, not performance measurements.

- `packages/gateway/src/data-plane/chat/openai-responses/serve-prep.ts` returns an explicit preparation result, and `attempt.ts` accepts explicit source-owned inputs. vNext follows that separation while retaining its original execution and continuation owners.
- Reference protocol-specific request helpers separate synchronous payload correction from orchestration. The preceding vNext batch made that distinction enforceable with `RequestTransform` and `beforeRequest`; this batch applies the same synchronous contract to preparation observation.
- `openai-responses/items/store.ts` has explicit attempt seeding and private-payload operations. vNext adopts explicit ownership and narrow dependencies. Its scratchpad must last across the entire lazy hosted response, not one provider fetch.
- Reference private replay uses hydration and persistence paths. vNext does not gain those features by renaming its memory store: its existing native snapshot and public protocol behavior remain authoritative.

The reference clones payloads at store boundaries. This batch deliberately retains trusted borrowed references to avoid adding copies without evidence of need. Reader-only capability is an operation boundary, not deep immutability. The default owned source avoids cross-invocation sharing and write-time global TTL sweeps; the explicitly injected legacy TTL store retains its behavior. These are source-level mechanism changes, not measured CFW gains.

## Contract limits and next priorities

- Type contracts constrain trusted TypeScript callers; unsafe casts and detached work deliberately scheduled inside a synchronous callback are outside their guarantee.
- The legacy borrowed store retains its `void` signatures for compatibility. Its adapter cannot prove that a foreign implementation obeys the synchronous storage convention; the stricter `undefined` contract applies to new owned capabilities.
- Ingress parsers intentionally preserve vendor extensions and do not validate a complete vendor request schema. Honest raw-object versus routing-ready types, including minimal model validation, need a separate behavior-specified increment; precise preparation output does not imply full ingress validation.
- Owned scratchpad lifetime does not bound the size of one active search, total concurrent state, or diagnostic capture. Numeric admission, overflow behavior and representative workloads remain a separate resource gate.
- Compared with the former TTL default, a long-running active invocation retains replay data until closure instead of expiring it mid-loop. This preserves replay correctness but does not guarantee lower active memory; both active peaks and post-response retention need measurement.
- An iterable abandoned without `return`, `throw`, abort or producer discard supplies no cleanup signal. Deterministic cleanup covers signaled lifecycle paths, not arbitrary retained references.
- Exact-artifact local workerd CPU/heap/latency comparison, catalog/affinity upgrade and rollback qualification, and disposition of the preserved collaboration overlay remain release gates. Local type/tests/build success does not establish production effectiveness.
- Further architecture work should keep the same contract checklist: input, guaranteed output, allowed mutation, owner, lifetime, error outcome and compatibility. Call-local translation state and typed settlement projections are later candidates; they must preserve native JSON and existing completion authority.
