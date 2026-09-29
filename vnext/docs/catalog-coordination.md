# Model catalog coordination

Stored upstream discovery uses SQL catalog rows partitioned by upstream and catalog code revision. Registry revision 5 does not import legacy KV snapshots. Discovery observes the authoritative upstream configuration and referenced proxy rows, acquires a 30-second lease, and completes within a 20-second total budget. Successful snapshots are fresh for two minutes; stale snapshots remain available during refresh and persistent failure backoff. Request-token Copilot catalogs stay request scoped.

Explicit refresh joins a live lease. A completed token identifies its safe success/failure outcome. Only one terminal outcome is retained per catalog row: if another attempt overwrites it before a joiner observes it, the joiner receives `superseded-unavailable`. A later attempt's result is never attributed to the joined attempt. Editor GET without `refresh=1` performs no upstream discovery.

Discovery transports carry their cancellation lifetime on the injected fetch function. The HTTP retry helper combines that lifetime with the request signal, including retry backoff. Dispatch providers are constructed separately and do not retain the discovery deadline. Independently canceled waiters do not cancel another request's winning discovery or shared credential exchange. Non-cooperative transports can outlive cancellation, but cannot publish their late result.

## Optional revision cleanup

Set `MODEL_CATALOG_ACTIVE_REVISIONS` to a JSON array containing the complete revision inventory still deployed, for example `[4,5]` during a supported rollout. Supply it through Bun environment variables or Cloudflare Worker variables. It must contain this code's revision, have unique positive safe integers and contain at most 32 entries. Missing or invalid configuration disables catalog revision deletion.

The existing Bun timer and Cloudflare scheduled handler run cleanup. Each tick deletes at most 128 inactive catalog rows last used more than seven days ago, retaining live leases, the declared active revisions, and every revision newer than this isolate's code. Never remove an older revision from the inventory until its deployment is retired. No live configuration is changed automatically.

SQL remains the publication authority. An outage can retain a previously authorized L1 snapshot; a cold outage fails unavailable. L1 is bounded to 512 entries, and background refresh bookkeeping is bounded separately to 512. Authorization still follows the gateway configuration lease: an L1 hit does not prove an unobserved remote revocation has already propagated.
