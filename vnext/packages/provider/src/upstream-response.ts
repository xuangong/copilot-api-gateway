/**
 * UpstreamResponse — discriminated union returned by ModelProvider's per-endpoint
 * `call*` methods (added in Phase A Task 2). Compared to the older
 * `provider.fetch()` which always returns a raw `Response`, this shape lets
 * adapters split streaming vs non-streaming and surface HTTPError without
 * exception propagation.
 *
 * Three terminal states:
 *  - { ok: true, stream: true,  body: AsyncIterable<TStream>, ... }
 *  - { ok: true, stream: false, body: TBody, ... }
 *  - { ok: false, error: HTTPError, ... }
 *
 * `headers` is the upstream's Headers (not the downstream-facing ones).
 * Translators are free to ignore them; observability code reads
 * `request-id` etc.
 */
import type { HTTPError } from './errors'

export type UpstreamResponse<TStream = unknown, TBody = unknown> =
  | { ok: true; status: number; stream: true; body: AsyncIterable<TStream>; headers: Headers }
  | { ok: true; status: number; stream: false; body: TBody; headers: Headers }
  | { ok: false; status: number; error: HTTPError }
