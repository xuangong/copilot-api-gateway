### Spec Compliance

- ✅ Spec compliant for the codec/catalog foundation package. The encoder preserves declaration duplicates, callable history and search-loaded positions, applies the required wire controls, records request echoes and generated-prefix provenance, and rejects ambiguous callable identities (`vnext/packages/provider-codex/src/responses-lite.ts:110`, `:159`, `:171`, `:280`). Production activation remains explicitly deferred; this is not full C07 completion.
- ✅ Strict absent/false/true catalog behavior is implemented without truthy coercion, and discovery revision is advanced (`vnext/packages/provider-codex/src/models.ts:175`, `:185`; `vnext/packages/gateway/src/data-plane/providers/registry.ts:181`; `vnext/packages/provider-codex/src/__tests__/models-lite.test.ts:10`).
- ⚠️ Full CI, protected collaboration-delta integration, clean frozen dependency installation, and the next package's production dispatch/persistence acceptance remain controller gates. The lock entry uses an explicit public Microsoft mirror URL (`vnext/bun.lock:1244`); that alone is not evidence of incompatibility. No clean-install claim is made here.
- ⚠️ The delivered test diff covers the named reference behaviors extensively (`vnext/packages/provider-codex/src/__tests__/responses-lite.test.ts:50` onward), but exact fixture-for-fixture equality with the pinned reference source was not independently established; this review did not broaden into an additional reference checkout crawl.

### Strengths

- Per-call inverse state is allocated inside the frame-restorer factory, shared by neither provider instances nor separately created adapters; generator cancellation and done-frame identity are preserved (`vnext/packages/provider-codex/src/responses-lite.ts:499`, `:523`, `:530`; `vnext/packages/provider-codex/src/__tests__/responses-lite-adapter.test.ts:17`, `:70`).
- Compact inversion requires both structural identity and matching generated IDs, preserves ambiguous caller copies, and replaces at most one generated representation. Unknown and modified lookalikes remain untouched (`vnext/packages/provider-codex/src/responses-lite.ts:264`, `:408`; `vnext/packages/provider-codex/src/__tests__/responses-lite.test.ts:353`, `:376`).
- The dependency owns the UUID implementation rather than reproducing UUID rules in application code, with exact OID namespace and independent ASCII/Unicode/thread vectors (`vnext/packages/provider-codex/package.json:22`; `vnext/packages/provider-codex/src/responses-lite.ts:62`; `vnext/packages/provider-codex/src/__tests__/responses-lite-adapter.test.ts:34`).
- UTF-8 chunk boundaries, parser failures, opaque scalar behavior, exceptions, cancellation and natural EOF receive focused tests; the adapter does not invent terminal success (`vnext/packages/provider-codex/src/__tests__/responses-lite-adapter.test.ts:44`, `:62`, `:70`, `:93`).

### Issues

#### Critical (Must Fix)

- None identified in the reviewed foundation diff.

#### Important (Should Fix)

- None identified in the reviewed foundation diff.

#### Minor (Nice to Have)

- `task-C07-codec-report.md:37`: Targeted ESLint reports a pre-existing multiple-project resolver advisory. Exit zero is useful evidence but not pristine output; the controller should retain the advisory in acceptance reporting or address the existing lint configuration separately. This is not a codec correctness blocker.

### Checks and Boundaries

- Reviewed the frozen patch, task briefs, preparation, implementer report and root/vNext AGENTS. Initial combined tool output was truncated; missing patch portions were read in bounded segments. No changed product file was separately reread, no product/index/branch mutation was made, and no suite was rerun.
- Named external-code risk: `uuid` could choose a Node-only implementation on Workers. Inspected the installed dependency's package export conditions and SHA-1 implementations: `node` selects `dist-node`, whose SHA-1 imports `node:crypto`, while the default condition selects `dist`, which implements SHA-1 without that import. This is dependency inspection, not a claim that every bundler chooses the same condition (`vnext/packages/provider-codex/node_modules/uuid/package.json:25`, `dist-node/sha1.js:1`, `dist/sha1.js:16`).
- Read controller-provided frozen runtime evidence `/tmp/vnext-c07-codec-frozen-runtime.out:1`: actual Bun and local workerd both pass six targeted groups including three independent UUID vectors, same-item-ID adapter isolation, compact provenance, search identity/collision checks, iterator termination and strict catalog validation. This resolves the concrete runtime portability concern for the exercised configurations; clean frozen installation remains separate.

### Assessment

**Task quality:** Approved

**Reasoning:** The foundation has coherent encode/inverse semantics, explicit request-scoped lifecycle ownership, strict catalog selection and meaningful boundary coverage. No blocking defect was found; approval is task-scoped and does not imply production Lite activation, completed clean-install validation, protected integration success or full C07 acceptance.
