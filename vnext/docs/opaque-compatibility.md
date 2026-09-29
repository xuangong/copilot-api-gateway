# Explicit opaque-state compatibility

Custom and Azure upstream owners can declare that specific execution models accept each other's opaque continuation state. This is an operator assertion, not tested cross-vendor interoperability. A wrong assertion can cause the upstream to reject a request or misinterpret state. Leave the field unset unless the upstream contract establishes compatibility.

Configure the optional `config.opaqueCompatibility` map through the upstream management API or an admin configuration import. Each value must be exactly `{ "version": 1, "key": "your-contract-id", "scope": "credential" | "owner" }`. Identifiers must be nonempty, unpadded strings of at most 512 characters; unknown declaration fields are rejected. There is no wildcard or global default.

For Custom, map keys are the exact model IDs sent upstream:

```json
{
  "opaqueCompatibility": {
    "model-a": { "version": 1, "key": "my-service-state-v1", "scope": "owner" },
    "model-b": { "version": 1, "key": "my-service-state-v1", "scope": "owner" }
  }
}
```

For Azure, qualify each execution target by surface. `openai:<deployment>` uses the final URL deployment chosen by the configured deployment resolver. `anthropic:<model>` uses the exact request body model sent to the Anthropic surface. Public model aliases do not grant declarations:

```json
{
  "opaqueCompatibility": {
    "openai:production-deployment": { "version": 1, "key": "my-service-state-v1", "scope": "credential" },
    "anthropic:actual-model": { "version": 1, "key": "my-other-state-v1", "scope": "credential" }
  }
}
```

`credential` permits wider model compatibility only within the same provider, upstream incarnation and credential revision. `owner` can span authorized upstreams, but the carrier remains bound to its original owner and API key. Matching declaration text never bypasses authentication, key routing rules, disabled models, or explicit upstream pins. Remote catalog metadata, provider names, matching API keys and model prefixes confer no compatibility.

Exact execution targets retain highest preference; matching declared groups precede safe optional-state removal. Candidate order stays stable within each rank. Required native continuation state must find a compatible, representable target; it cannot be silently discarded. Catalog reconstruction reads the current validated owner configuration. If an Azure catalog model spans surfaces with different or missing declarations, its catalog declaration is omitted; actual execution preparation still uses the selected surface. This configuration feature preserves the existing exact-target identity semantics, including Azure's existing deployment/body-model identity, and does not redefine exact matching.

Use `PATCH /api/upstreams/:id` with `{"config":{"opaqueCompatibility":{}}}` to remove all declarations. Supplying a map replaces that map; omitting it in a PATCH preserves saved declarations. Existing dashboard edits preserve the field, although the dashboard has no dedicated compatibility editor. Changes advance the existing configuration generation and invalidate prepared executions before provider I/O. Imports validate declarations before any replace-mode deletion. Nonsecret declarations are retained in redacted exports; affinity secrets are never part of this field.

Upstream creation, modification and deletion require user-session authority and existing owner/admin rights. Inference API keys, including assigned keys, cannot mutate upstream configuration. An explicit API key takes authentication precedence over a session cookie and therefore also denies these writes. Admin configuration import retains its existing admin-only gate.

This slice provides configuration producers for the existing affinity pipeline. It does not expand protocol support or claim that all providers support opaque-state replay.
