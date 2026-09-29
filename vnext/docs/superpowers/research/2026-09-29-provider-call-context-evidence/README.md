# Per-call provider context acceptance

Base: `60dfcbfcd9766f83698adb20808eeb4330ed8aef`. The exact frozen product hashes accompany this evidence.

## Behavior and validation

The LLM ProviderResponse extension carries immutable execution identity and optional call-local parsed Responses adapters. JSON adapts once before event synthesis; SSE adapts frames before translation, observation and outer shims. Telemetry retains the provider-selected raw pricing key despite a base-model response echo. Existing fallback inference remains when metadata is absent. Transport packages and raw capture retain their prior contract.

- Writer focused regression:568pass/0fail;14new focused cases. Strict package/test types, purity and scoped lint pass.
- Root clean `bun run ci:local`:4604pass/1existing skip/0fail. All typechecks, purity, lint(0errors/35inheritedwarnings), UI build and Workers dry-run pass.
- Root frozen actual Bun loopback HTTP through gateway attempt/responders and real temporary SQLite: five concurrent cases pass (Responses JSON/SSE, Chat via Responses JSON/SSE, and absent-metadata fallback). Canonical per-call output and completion snapshot callbacks retain the correct call's restoration. Actual usage rows retain input alias, public model, synthetic executed-fast key with input/output unit prices20/40; absent metadata retains base key and2/4. Performance wrapping is active.

The baseline reproduced missing unary adaptation. Initial probe corrections fixed a helper import path and replaced invalid inputPerM/outputPerM fixture pricing names with real input/output dimensions; the final assertions require concrete SQL prices, not null. Only synthetic provider data and loopback traffic were used. This does not establish live provider availability, authorization-route coverage, workerd execution or a new durable storage guarantee.

## Integration and scope

This foundation does not itself implement Fast selection, Lite encoding, affinity carriers or model availability. Later producers must attach their immutable prepared call context at the final LLM response boundary after authentication retry. No migration or new environment variable is introduced.

Two protected user files overlap this package. The clean commit excludes their diagnostics/collaboration delta. Root's documented three-way parse-block resolution retains existing raw JSON/SSE diagnostics before adaptation; exact reverse conflict resolution must reproduce the original user file bytes. All unrelated changes and recovery snapshots/stashes remain preserved. This preservation evidence is kept in the plan scratch; the user-owned diagnostics are not delivered as part of this clean commit.
