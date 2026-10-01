# Task 1 independent spec and quality review

Reviewed range: `bf4db4312d4c0c85eaf8449f041e90a5d00c24e9..54289f3c2c5b181952bb672e244729a596e62508`.
Date: 2026-10-01. Scope: hosted search operation admission only.

## Spec compliance

PASS. The seven-file change implements Task 1 without implementing the later body, ingress, retention, continuation or diagnostic policies.

- `capacity.ts:1-35` declares the eight specified defaults and accepts only positive safe-integer overrides no larger than their defaults. The error contains the category and configured limit, with no argument payload.
- `capacity.ts:39-51` counts supported defined arrays and unsupported arrays by length, includes sparse holes without reading entries, skips supported undefined fields, charges other scalars once, and applies the minimum call charge. Saturation returns before accessing later field values.
- `execution-scope.ts:114-122` checks openness, counts before expansion, checks openness again after reflection, and atomically reserves the entire call. Rejection reserves nothing; there is no refund path.
- `execution-scope.ts:105-110,124,128-130` enforces scope-local token identity and single consumption. Consumption precedes parsing, including parser failures; refusal does not parse. Cancellation clears outstanding token ownership at line 96.
- Responses `web-search.ts:475-494` and Chat `with-chat-completions-web-search-shim.ts:344-355` admit before their iteration-refusal branches and before preparation. Their invocation-owned execution scope remains shared over turns. Capacity exhaustion throws before refusal output, slots for the offending call, provider start or another model turn.
- Existing work registration, cancellation, delivery and real-settlement mechanisms remain in place. Normal per-call planning and fanout remain delegated to the original planner.
- No new dependencies, migrations, environment variables, `any`, suppressions or non-null assertions appear in the reviewed diff. Protected overlays are outside the changed-file list.

## Strengths

The admission port makes the required ordering explicit rather than relying on caller discipline around a raw argument parser. The private token map bounds outstanding reservations by the operation budget and separates refusing a call from expanding it. The post-reflection openness check protects cancellation during getters without altering settlement ownership.

Tests cover the meaningful boundaries: enormous sparse arrays without element reads; exact capacity; whole-call atomic rejection; merged-query cardinality; malformed and empty calls; nonrefunding abandoned and failed preparations; cross-scope/repeated token consumption; refusal without parsing; and cancellation during reflection. Actual caller tests exercise cumulative turns and refusal charging, checking provider counts and absence of extra continuation. Existing cancellation and usage-settlement tests are retained rather than replaced.

## Findings

### Critical

None.

### Important

None.

### Minor

None introduced by this change. The reported `require-yield` warning at Responses `web-search.ts:615` is consistent with the existing async generator returning a terminal slot result through the dispatcher contract; the diff changes no code inside that generator. This warning does not indicate a missing yield required by Task 1 and does not block approval.

## Targeted context inspected outside the diff

Only concrete integration risks justified additional inspection:

- **Counter/parser cardinality mismatch:** `tools/web-search/operations.ts:180-258` and `plan-operations.ts:75-95,132-163` confirm array-length cardinality, supported undefined behavior, unsupported fields, minimum malformed plans and merged searches. The parser's legacy direct supported-property access also admits inherited/nonenumerable supported fields on arbitrary JavaScript objects; ordinary protocol arguments come from JSON and have own enumerable fields. The specified own-key counter intentionally ignores inherited fields, and the design excludes mutable/reflection-created input graph guarantees. No production JSON-path bypass was found and no parser semantic change is requested here.
- **Argument JSON parsing before admission:** `chat-flow/shared/tool-arguments.ts` and Responses `server-tool-shim.ts:675-688` confirm the existing JSON repair/parse boundary precedes admission. The specification expressly excludes preexisting JSON parsing/input graphs; operation parser expansion remains after admission.
- **Failure swallowed into successful refusal or continuation:** Responses `server-tool-shim.ts:1084-1107` routes thrown dispatcher failures to the existing failed response owner; Chat `web-search-result-owner.ts:108-145` closes the scope and propagates generator failures. Scope creation and closure were inspected in the two modified caller files. No new catch or successful-error conversion was added.

## Verification evidence and limitations

Reviewed the brief, implementation report, full supplied diff, changed production source, and reported lint output. The report records 96 focused tests passing, gateway typecheck and purity passing, scoped lint with zero errors and one existing warning, and protection verification for 38 main / 14 isolated files. These are implementation-reported results; tests and checks were not rerun as instructed. No services, network calls, full CI, index changes, source edits or commits were performed during review. The only written artifact is this review.

The numeric policy remains provisional engineering policy, not a measured isolate memory or performance guarantee. Later policy domains and the final combined CI/freeze remain separate tasks.

## Quality verdict

APPROVED for Task 1. No corrective changes are required within the reviewed scope. Proceed to subsequent tasks while retaining the existing cancellation/settlement owners and protected overlays.
