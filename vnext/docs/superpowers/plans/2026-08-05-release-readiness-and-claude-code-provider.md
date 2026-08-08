# vNext Release Readiness and Claude Code Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore every local release gate, complete and register the Claude Code provider, automate local and credentialed compatibility checks, and update release documentation with verified evidence.

**Architecture:** Core packages own runtime-neutral upstream and HTTP boundary types. The Claude Code package implements subscription-specific credential, catalog, mimicry, and forwarding behavior behind the existing vNext `LlmProviderPlugin` contract. Gateway registration, CI, and documentation consume those stable package boundaries without importing reference-project frameworks.

**Tech Stack:** TypeScript 5.9, Bun 1.3, Hono, React 19, ESLint 9, GitHub Actions, Wrangler 4, Cloudflare Workers, Bun SQLite.

---

### Task 1: Restore Core Dependency Purity

**Files:**
- Modify: `vnext/packages/upstream/src/types.ts`
- Modify: `vnext/packages/upstream/src/index.ts`
- Modify: `vnext/packages/protocols-llm/src/common/types.ts`
- Modify: `vnext/packages/protocols-llm/src/common/index.ts`
- Modify: `vnext/packages/upstream-repo/package.json`
- Modify: `vnext/packages/upstream-repo/src/types.ts`
- Test: `vnext/scripts/check-framework-purity.ts`

- [ ] **Step 1: Reproduce the purity violation**

Run: `cd vnext && bun run scripts/check-framework-purity.ts`

Expected: FAIL showing `@vibe-core/upstream-repo` depends on or imports `@vibe-llm/protocols`.

- [ ] **Step 2: Move the generic upstream record to core**

Define the generic record in `@vibe-core/upstream` with the fields currently exposed by the protocol type, export it from the package, and make the protocol package re-export or compose that core type while retaining the existing `UpstreamKind` union.

- [ ] **Step 3: Repoint upstream-repo to core**

Replace the package dependency and source import with `@vibe-core/upstream`, preserving the existing generic repository method signatures.

- [ ] **Step 4: Verify purity and affected typechecks**

Run: `cd vnext && bun run scripts/check-framework-purity.ts && bun run --filter '@vibe-core/upstream' typecheck && bun run --filter '@vibe-core/upstream-repo' typecheck && bun run --filter '@vibe-llm/protocols' typecheck`

Expected: all commands exit 0.

### Task 2: Restore Typecheck and Lint Gates

**Files:**
- Modify: `vnext/packages/provider-llm/src/images.ts`
- Modify: `vnext/packages/provider-sdf/src/provider.ts`
- Modify: `vnext/packages/provider-custom/src/provider.ts`
- Modify: `vnext/packages/provider-azure/src/provider.ts`
- Modify: `vnext/packages/provider-codex/src/__tests__/provider.integration.test.ts`
- Modify: `vnext/eslint.config.mjs`
- Modify: `vnext/package.json`
- Modify: files reported by `bun run lint`

- [ ] **Step 1: Capture failing typecheck and lint output**

Run: `cd vnext && bun run typecheck; bun run lint`

Expected: type errors for DOM aliases and lint errors matching the audit baseline.

- [ ] **Step 2: Replace ambient DOM aliases**

Use runtime-neutral aliases based on the available Fetch API constructors, such as `RequestInit['body']` and `Headers` constructor parameters, or package-owned structural types when the runtime declaration does not expose an alias. Do not add `DOM` to the global TypeScript library list.

- [ ] **Step 3: Configure React Hooks linting**

Add `eslint-plugin-react-hooks`, register it for dashboard TypeScript/TSX files, and enable the recommended hooks rules without leaving unresolved inline rule references.

- [ ] **Step 4: Resolve all lint errors**

Make focused behavior-preserving corrections for `prefer-const`, empty blocks, unused assignments, generator declarations, and caught-error cause handling. Do not refactor unrelated code.

- [ ] **Step 5: Verify typecheck and lint**

Run: `cd vnext && bun run typecheck && bun run lint`

Expected: both commands exit 0.

### Task 3: Complete Claude Code Provider Foundations

**Files:**
- Modify: `vnext/packages/provider-claude-code/package.json`
- Modify: `vnext/packages/provider-claude-code/src/index.ts`
- Modify: `vnext/packages/provider-claude-code/src/headers.ts`
- Modify: `vnext/packages/provider-claude-code/src/pricing.ts`
- Create: `vnext/packages/provider-claude-code/src/defaults.ts`
- Create: `vnext/packages/provider-claude-code/src/access-token.ts`
- Create: `vnext/packages/provider-claude-code/src/detection.ts`
- Create: `vnext/packages/provider-claude-code/src/models.ts`
- Create: `vnext/packages/provider-claude-code/src/usage-probe.ts`
- Test: `vnext/packages/provider-claude-code/src/__tests__/*.test.ts`

- [ ] **Step 1: Add failing foundation tests**

Cover Claude Code header selection, shaped-request detection, OAuth/setup-token access-token resolution, terminal refresh persistence, raw model validation, catalog conversion, pricing selection, and quota/usage normalization.

- [ ] **Step 2: Run the focused tests red**

Run: `cd vnext && bun test packages/provider-claude-code/src/__tests__`

Expected: new tests fail because the provider foundation modules or exports are absent.

- [ ] **Step 3: Implement access and catalog behavior**

Adapt the reference behavior to vNext state and repo contracts, using atomic `saveState` updates for refresh results and vNext `ProviderModel` shapes for model output.

- [ ] **Step 4: Implement detection, defaults, pricing, and usage**

Keep Claude subscription mimicry policy inside the provider package and expose only the functions required by the provider and tests.

- [ ] **Step 5: Run focused tests green**

Run: `cd vnext && bun test packages/provider-claude-code/src/__tests__ && bun run --filter '@vibe-llm/provider-claude-code' typecheck`

Expected: tests and package typecheck exit 0.

### Task 4: Implement Forwarding, Plugin, and Gateway Registration

**Files:**
- Create: `vnext/packages/provider-claude-code/src/fetch.ts`
- Create: `vnext/packages/provider-claude-code/src/provider.ts`
- Create: `vnext/packages/provider-claude-code/src/plugin.ts`
- Create: `vnext/packages/provider-claude-code/src/interceptors/messages/system-blocks.ts`
- Modify: `vnext/packages/provider-claude-code/src/index.ts`
- Modify: `vnext/packages/gateway/package.json`
- Modify: `vnext/packages/gateway/src/data-plane/providers/registry.ts`
- Test: `vnext/packages/provider-claude-code/src/__tests__/provider.test.ts`
- Test: `vnext/packages/provider-claude-code/src/__tests__/plugin.test.ts`
- Test: `vnext/packages/gateway/tests/provider-binding.test.ts`

- [ ] **Step 1: Add failing forwarding and registry tests**

Test non-stream Messages calls, SSE passthrough, shaped request preservation, ordinary request adaptation, access-token injection, model lookup, upstream errors, plugin construction, and registry inclusion.

- [ ] **Step 2: Run the focused tests red**

Run: `cd vnext && bun test packages/provider-claude-code/src/__tests__/provider.test.ts packages/provider-claude-code/src/__tests__/plugin.test.ts packages/gateway/tests/provider-binding.test.ts`

Expected: tests fail because forwarding, plugin, or registration behavior is missing.

- [ ] **Step 3: Implement the provider boundary**

Implement the vNext `LlmProvider` methods supported by Claude Code, reject unsupported endpoint families through the established provider error pattern, and preserve abort signals, response status, headers, and streams.

- [ ] **Step 4: Register the plugin**

Add the provider dependency to the gateway package and include `claudeCodeProviderPlugin` in the registry map keyed by `claude-code`.

- [ ] **Step 5: Run focused and full provider tests**

Run: `cd vnext && bun test packages/provider-claude-code packages/gateway/tests/provider-binding.test.ts && bun run typecheck`

Expected: all commands exit 0.

### Task 5: Add Continuous Integration and Remote Compatibility Workflows

**Files:**
- Create: `.github/workflows/vnext-ci.yml`
- Create: `.github/workflows/vnext-remote-compat.yml`
- Modify: `vnext/package.json`
- Modify: `vnext/scripts/parity/run-audit.ts` or the current parity entrypoint if required for non-interactive execution

- [ ] **Step 1: Define a single local CI gate script**

Add a script that runs framework purity, workspace typecheck, tests, lint, dashboard build, and Cloudflare dry-run in a deterministic order.

- [ ] **Step 2: Add PR and push CI**

Use Bun setup, install with the lockfile, run the local gate, and upload relevant failure artifacts without requiring repository secrets.

- [ ] **Step 3: Add manual remote compatibility CI**

Accept old and vNext base URLs, map SDK credentials from secrets, execute OpenAI/Anthropic/Gemini compatibility tests and parity fixtures for both endpoints, and upload reports. Missing secrets must produce an explicit skipped summary rather than a false pass claim.

- [ ] **Step 4: Validate workflow syntax locally**

Parse both YAML files and inspect all referenced scripts and paths. Run every non-credentialed command invoked by the local workflow.

Expected: local workflow commands exit 0; remote workflow remains manually credentialed.

### Task 6: Update Documentation and Cutover Evidence

**Files:**
- Modify: `README.md`
- Modify: `vnext/README.md`
- Modify: `vnext/CUTOVER_AUDIT.md`
- Modify: `vnext/CUTOVER_PLAYBOOK.md`

- [ ] **Step 1: Update architecture and command documentation**

Document 19 packages, 3 apps, current provider support, exact local commands, Cloudflare and Docker entrypoints, and the distinction between client compatibility and upstream provider kinds.

- [ ] **Step 2: Replace stale cutover evidence**

Record the final local test counts and gate results with the date `2026-08-05`. Leave credentialed SDK dual-run and production deployment explicitly pending unless they are actually executed.

- [ ] **Step 3: Update the playbook**

Use current paths and commands, include the CI gate, remote compatibility gate, deployment smoke checks, rollback checks, and data-binding validation.

- [ ] **Step 4: Scan for stale claims**

Run: `rg -n '骨架阶段|所有包仅有|14 个 package|237 tests|待引入|当前未写' README.md vnext/README.md vnext/CUTOVER_AUDIT.md vnext/CUTOVER_PLAYBOOK.md`

Expected: no stale project-state claims remain.

### Task 7: Final Verification and Handoff

**Files:**
- Verify only; restore incidental generated output if source inputs did not change.

- [ ] **Step 1: Run the complete local gate**

Run: `cd vnext && bun run ci:local`

Expected: purity, typecheck, tests, lint, dashboard build, and Worker dry-run all exit 0.

- [ ] **Step 2: Verify legacy baseline**

Run: `bun run typecheck && bun run test`

Expected: legacy typecheck and unit tests exit 0.

- [ ] **Step 3: Inspect repository state**

Run: `git status --short --branch && git diff --check`

Expected: only intentional task changes plus the two pre-existing untracked Claude Code files now incorporated into the provider implementation.

- [ ] **Step 4: Report remote limitations accurately**

List the exact workflow and secrets required for remote SDK dual-run and production cutover. Do not report either as passed until workflow evidence exists.
