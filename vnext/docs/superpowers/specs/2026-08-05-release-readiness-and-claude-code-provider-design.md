# vNext Release Readiness and Claude Code Provider Design

**Date:** 2026-08-05

## Goal

Restore all local engineering gates, complete the Claude Code subscription
provider using `/Users/zhangxian/projects/copilot-gateway` as the behavioral
reference, automate release validation, and bring the vNext documentation and
cutover records in line with the current repository.

## Current State

- The raw vNext test suite passes 1369 tests across 217 files.
- `bun run typecheck` fails because fetch API boundary types such as
  `BodyInit` and `HeadersInit` leak into packages whose TypeScript library set
  intentionally contains only `ESNext`.
- `bun run test` stops before executing tests because
  `@vibe-core/upstream-repo` imports the business package
  `@vibe-llm/protocols`.
- `bun run lint` reports 35 errors and 18 warnings.
- The Claude Code package contains authentication, identity, state, quota, and
  import foundations, but no complete provider, plugin, model catalog, access
  token lifecycle, request forwarding, or gateway registration.
- The root README, vNext README, cutover audit, and playbook describe different
  repository states.
- No repository CI workflow currently enforces the documented gates.

## Decision

Implement behavioral parity with the reference Claude Code provider while
adapting all integration points to vNext conventions. Do not copy the
reference project's provider framework or interceptor architecture into
vNext.

The reference project is authoritative for upstream-facing behavior:

- OAuth and setup-token lifecycle
- access-token refresh and terminal-session handling
- Claude Code request detection
- model discovery and catalog normalization
- pinned request headers and body mimicry
- quota and usage parsing
- stream and non-stream forwarding behavior

vNext remains authoritative for:

- package dependency direction
- `LlmProvider` and `LlmProviderPlugin` contracts
- provider registry and chat-flow dispatch
- shared repo access
- telemetry, dumps, and error envelopes
- TypeScript, test, and lint conventions

## Scope

### 1. Engineering Gates

Move the generic upstream record contract into a core-owned package and make
both protocols and upstream-repo consume that contract without a core-to-LLM
dependency. Preserve existing public imports where practical through a
business-layer re-export.

Replace ambient DOM-only request body and header aliases at package boundaries
with runtime-neutral structural types or standard platform-owned aliases. Do
not add the complete DOM library globally merely to silence compiler errors.

Install and configure the React Hooks ESLint plugin for dashboard sources.
Resolve all existing lint errors, including empty blocks, stale assignments,
generator declarations, caught-error cause handling, and missing hook rules.
Warnings may remain only when deliberately allowed by the repository config;
the final lint command must exit successfully.

### 2. Claude Code Provider

Complete `@vibe-llm/provider-claude-code` with the following responsibilities:

- Ensure a valid access token from either OAuth or setup-token state.
- Refresh OAuth credentials atomically through the upstream repository.
- Mark terminal refresh failures in persisted state and surface a typed error.
- Fetch and validate the Claude Code model catalog.
- Convert raw Claude models into vNext provider models with Messages endpoint
  capability, context limits, modalities, reasoning controls, and pricing.
- Detect requests already shaped by Claude Code and preserve their body shape.
- Adapt ordinary Anthropic Messages requests to the Claude Code subscription
  wire contract using the reference provider's system-block, metadata, tool,
  and header rules.
- Forward non-stream and SSE stream requests while preserving abort signals,
  upstream errors, retry metadata, and usage information.
- Expose a `claudeCodeProviderPlugin` using the vNext plugin contract.
- Register the plugin in the gateway provider registry.
- Ensure import/export and control-plane upstream-kind handling accepts
  `claude-code` without special-case failures.

Provider-specific transformations stay inside the provider package when they
exist solely to mimic Claude Code traffic. Generic protocol translation and
gateway policy remain in their existing packages.

### 3. Testing Strategy

Use test-driven development for every behavior change:

- Start with focused failing tests for core dependency ownership and fetch
  boundary types where executable checks are possible.
- Port reference provider tests by behavior rather than by internal function
  shape.
- Add tests for token refresh, terminal refresh errors, request detection,
  headers, model validation, model normalization, non-stream forwarding,
  streaming forwarding, plugin construction, and registry inclusion.
- Keep all existing vNext tests passing.
- Run the framework purity script before the full test suite.

The local release gate is:

```sh
cd vnext
bun run typecheck
bun run test
bun run lint
bun run build:ui
bun run --filter '@vibe-llm/platform-cloudflare' deploy:dry
```

### 4. CI and Remote Compatibility

Add a pull-request and push workflow that installs Bun dependencies and runs
the complete local release gate. Cache configuration must not make correctness
depend on a warm cache.

Add a manually triggered remote compatibility workflow for credentialed
checks. It will:

- accept old-gateway and vNext base URLs through workflow inputs or secrets;
- run the OpenAI, Anthropic, and Gemini SDK compatibility suites against both;
- run the maintained parity fixtures against both;
- upload reports as artifacts;
- clearly report skipped suites when required secrets are unavailable.

Remote compatibility remains a release requirement but cannot be represented
as locally passed without credentials and deployed endpoints.

### 5. Documentation and Cutover Records

Update the root README and `vnext/README.md` to describe the actual 19 packages
and 3 applications, current development commands, provider support, and
deployment layout.

Rewrite the cutover audit with dated evidence from the final verification run.
Separate the following statuses:

- locally verified;
- remotely verified;
- pending remote credentials or deployment;
- known non-blocking follow-up.

Update the playbook paths, commands, bindings, validation sequence, rollback
steps, and observability notes to match the current architecture. Do not claim
production cutover has occurred.

## Delivery Order

1. Repair package boundaries and typecheck.
2. Repair lint and make the standard test command execute the suite.
3. Complete and register the Claude Code provider.
4. Add local and remote CI workflows.
5. Execute all locally available verification.
6. Update documentation and cutover evidence from the observed results.

## Non-Goals

- Deploying either gateway to production.
- Changing production DNS or traffic routing.
- Running credentialed remote tests without user-provided endpoints and
  secrets.
- Replacing vNext's provider or interceptor architecture with the reference
  project's architecture.
- Refactoring unrelated legacy `src/` behavior.

## Completion Criteria

- `bun run typecheck`, `bun run test`, `bun run lint`, and
  `bun run build:ui` exit with code 0.
- Cloudflare Wrangler dry-run successfully produces the Worker bundle.
- The Claude Code provider supports credential lifecycle, catalog discovery,
  Messages forwarding, streaming, plugin creation, and gateway registration.
- Provider and registry behavior is covered by focused tests.
- CI expresses both the local mandatory gate and optional credentialed remote
  compatibility gate.
- Documentation contains no known skeleton-stage statements, stale workspace
  counts, or claims that pending remote tests have passed.
- Files changed by verification-only build steps are either intentionally
  reproducible artifacts or restored before handoff.

## Risks and Mitigations

- **Reference drift:** compare behavior and tests, not package internals.
- **Cross-runtime fetch types:** use structural/platform types and validate both
  Bun and Cloudflare package typechecks.
- **Subscription API changes:** keep header/model validation explicit so drift
  fails loudly in tests and catalog refreshes.
- **Credential mutation races:** use the upstream repository's atomic
  read-modify-write operation for refresh state.
- **CI secret exposure:** keep credentialed jobs manual and pass secrets only
  through environment variables with no diagnostic echoing.
- **Generated dashboard drift:** verify generated assets and avoid retaining
  incidental rebuild changes unless the source actually changed.
