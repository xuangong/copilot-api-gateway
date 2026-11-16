/** Thrown when code would rewrite or delete a row synced from another gateway. Lives in the repo layer so the repository can throw it without an import cycle. */
export class SyncedUpstreamReadOnlyError extends Error {
  readonly code = "synced_upstream_read_only"
  constructor() { super("synced_upstream_read_only") }
}
