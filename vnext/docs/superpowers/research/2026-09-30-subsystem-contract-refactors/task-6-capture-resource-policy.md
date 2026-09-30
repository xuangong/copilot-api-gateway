# Diagnostic payload ownership and resource policy

Status: implemented narrow slice; aggregate publication admission remains open.

## Admission and lifetime

The environment's `DumpCaptureBudget` accounts for retained diagnostic payloads across all accumulators in that environment/isolate. Defaults are 4 MiB of estimated reservation per capture, 16 MiB across captures, and 8,192 canonical frames per capture. Constructors may lower these limits; the policy cannot raise them. Admission is immediate and has no waiting queue.

The request reserves capacity before `prepareRequestBody` starts. Its estimate includes three times the request backing-buffer size plus a fixed allowance, covering request preparation without treating a short view of a large buffer as small ownership. Canonical frames reserve a private JSON projection: strings/keys charge their UTF-16 length plus fixed overhead, containers/scalars have conservative fixed charges, and arrays charge their bounded length. Projection visits stop at the available budget, 65,536 nodes or depth 64. These are representation estimates, not measured V8 heap limits.

Fallback output strings reserve UTF-8 capacity before encoding. `finalizeTurn` first projects the fallback, serializes that bounded projection, then reserves its maximum UTF-8 output size before allocating the encoded bytes. Legacy body capture admits chunks before retaining a private copy and tracks total forwarded bytes independently of retained chunks. Existing canonical transport forwarding keeps its single reader; no tee or secondary drain is added there. Compression remains serial under the existing store contract.

Reservations start at constructor admission and remain held until request preparation and the terminal record's store write plus broker publication have actually settled. Accounting is conservative after overflow: dropping payload references does not release a permit while already-started preparation or publication is still outstanding. Success, best-effort preparation/write/publication failure, rejected upstream lookup, fallback serialization failure and cancellation all share one idempotent release path. Cancellation keeps the existing semantic-completion bypass, but does not bypass request preparation or persistence ownership. Repeated finalize calls share the same terminal promise and reservation.

## Exact capture or an explicit omission

Within admission limits, ordinary JSON payload values and ordering remain exact. Captures retain private object/array projections rather than producer objects; strings are shared. Subsequent producer mutation or hidden properties cannot enlarge the retained diagnostic graph. Object non-enumerable/symbol state is excluded because JSON does not serialize it. Arrays preserve every own numeric index, including non-enumerable ones, and ignore named extras as JSON does. An ordinary data property named `toJSON` remains data. Callable/accessor serializers, accessors, unsupported prototypes and other non-JSON capabilities are rejected without invoking them.

If request, frame, fallback or captured-byte admission fails, the entire diagnostic request/response payload is omitted. No partial canonical event list is published as complete. `meta.capture` records `{ state: "omitted", reason }`, where reason is `capture_limit`, `environment_limit`, `frame_limit` or `unsupported_payload`. This status is independent of inference errors: HTTP status, client bytes, payload counters and ordinary inference outcome remain unchanged. Request/response bodies become empty/none, and this accumulator drops its optional upstream-capture ownership. The normal metadata-only persistence path remains best effort.

The status round-trips through existing `meta_json` without a schema migration, appears in list/detail UI, passes through the detail wire format and is allowlisted into redacted export. Older rows have no capture field. Unsupported-but-serializable fallback shapes produce an omission record; cyclic/BigInt fallbacks preserve the existing asynchronous serialization rejection instead of fabricating a successful record.

## Cost and unimplemented domains

The opt-in capture path now traverses and copies JSON containers once per accepted frame/fallback. It does not stringify each frame and shares immutable strings, but this adds CPU and allocation cost that must be measured on the exact artifact before rollout. No production speed, CPU or heap improvement is claimed.

The 16 MiB accounting cap is **not** a full environment heap bound. It excludes ingress JSON/body allocation, provider/result ownership, metadata/header/error strings, per-request object and promise counts, broker queues, control-plane readback/export, runtime allocation overhead, JSON serialization/codec working memory and transport-owned buffering. Legacy `tee()` can still queue data on its other branch even when diagnostic chunks are discarded. Optional upstream capture retains its separate pre-existing prefix budget and is not included in this aggregate payload estimate; external borrowed collectors retain their own lifecycle.

Metadata-only omitted captures use the existing direct best-effort write path. No new metadata waiting queue is introduced, but the number of simultaneous metadata/publication operations is not capped. A future publication-slot contract needs explicit admission-failure visibility, including what clients should see when no diagnostic row can be committed. This remains the priority gap before claiming total capture/publication protection. Artifact-specific workerd resource measurement remains a separate release gate.

## Exceptional request ownership

`9e54b9a2` adds an explicit abandonment handoff when preparation/responding exits before a normal response owner is installed. It preserves the original thrown value, seals the capture once, and waits for already-started preparation or a previously selected terminal write before releasing the reservation. It does not fabricate a response status or diagnostic record. Ordinary shared serves and confirmed direct owners use the guard; Responses retains its existing turn owner. The no-sink guard returns the original work promise directly, while its caller callback remains an allocation. See [the correction](final-fix-report.md) and [independent re-review](final-fix-review.md).
