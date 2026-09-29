# C07 protected dirty-byte integration compatibility

Scratch only. No product file/index/HEAD edits, no commit/push/deploy. Clean C07 codec remains independently approved and frozen; all 12 product SHA256 values were checked unchanged after this work.

## Reviewed outputs

Within `W/task-C07-codec-protected-proof/`:

- `events.ts.merged`: SHA256 `53776e65170c846367ef2869ca67f904f6f7ea0d6d592bf870276a1fbf453f5c`
- `index.ts.merged`: SHA256 `205d3940f08db4d47ec25dfa9d834d945667db09640875003c863da317c2e11c`
- `events.ts.reverse-proof`: SHA256 `a354b5ec824d4e1053485ba22985d3a4ea728034203698be74216b6db30182ad`, exactly equals captured `events.ts.user`.
- `index.ts.reverse-proof`: SHA256 `01c4760c6eccdad145a9151e69ff13f81c253666fc7773a9b42fb532caa9b561`, exactly equals captured `index.ts.user`.

`task-C07-codec-merge-resolutions.json` is keyed by the two repository-relative paths. Each entry records exact base/user/candidate source hashes, explicit forward/reverse conflict bodies and resolutions, ordered forward/reverse normalization rules with exact occurrence counts, raw merge SHA256 values after canonicalizing only temporary path labels in conflict markers, post-conflict/pre-normalization hashes and final hashes. This is not a generic choose-ours/theirs procedure. Labels are allowed to vary because root creates new integration snapshot paths; every non-label byte is pinned.

`task-C07-codec-normalize-merge.py` exposes:

```python
normalize_merge(data, direction, file, *, base, user, candidate) -> bytes
```

It performs all hash/anchor checks and raises ValueError on drift; it does no filesystem writes. CLI invocation replays all 4 exact transformations and tests 16 altered raw/source inputs are rejected.

## Semantic decisions

1. Explicit ResponsesResult conflict resolves to the full clean response-field block. Its `ResponsesTool` union includes the generic `{ type: string; [key: string]: unknown }` alternative, so original user tools remain accepted; `tool_choice` is retained once. Instructions/parallel/reasoning/service_tier additions remain.
2. The two incompatible AdditionalTools interfaces become one **union type** at the original user declaration location. One branch is the exact clean developer representation with nullable ID and typed tools; the other is the exact user's `ResponsesPermissiveItem<'additional_tools'> & { tools: Array<{type: string; [key: string]: unknown}> }`. This preserves optional/opaque role, unknown extensions, optional call_id/status/output/body and string ID on the user branch while retaining null ID for the strict developer branch. It avoids intersecting/narrowing the caller branch through interface merging.
3. Keep one namespace field in each function item interface at its user position; keep one AdditionalTools entry in each input/output union at the user position; keep one index export at the user position. Other clean callable/namespace tools exports remain. Keep queued event once.
4. All three original `encrypted_function_args?: string[] | null` fields and their comments remain unchanged in the combined dirty bytes. These do not enter the clean product candidate/commit.
5. Reverse merge initially removes overlapping user-owned `tools/tool_choice` and queued additions because Git also sees them in the clean delta. Exact reverse normalizations restore those captured blocks and restore the original AdditionalTools interface; the full output must equal `.user` bytes. There is no user-delta rewrite hidden in the reverse proof.

## Root integration wiring

The existing `integrate-provider-call-context.py` only invokes its resolver when merge-file reports a conflict. C07 MUST invoke the new normalizer for these two paths **unconditionally**, including a zero-exit merge, because index.ts forward has silent duplicate exports. Do not treat exit code 0 as sufficient.

Load the scratch module with importlib.util, then replace protected-path handling for these two files with:

```python
# After merge-file(current user, old base, clean candidate), return code 0 or 1:
merged_bytes = codec.normalize_merge(
    merged.stdout, 'forward', f,
    base=old[f], user=current, candidate=candidates[f],
)
# Save merged_bytes to snapshot, then merge-file(merged, candidate, base).
reverse_bytes = codec.normalize_merge(
    reverse.stdout, 'reverse', f,
    base=old[f], user=current, candidate=candidates[f],
)
assert reverse_bytes == current
```

Use the original captured `current` for both directions. Other protected paths continue through their own existing flow. A missing/changed hash must abort preflight; do not regenerate the manifest to accommodate drift. Clean candidate snapshots must remain exactly the frozen clean files. Apply combined `.merged` bytes only when root's integration flow reapplies protected dirty deltas after the clean commit/fast-forward.

The derivation helper `task-C07-codec-build-merge-rules.py` is retained for review of normalization rationale; it is NOT the integration API and must not be rerun against changed captures to bless drift.

## Validation

- `python3 W/task-C07-codec-normalize-merge.py`: PASS, 4 exact forward/reverse transformations, 16 raw/source drift rejections, no writes.
- Byte proof: both `.reverse-proof` files equal their corresponding original `.user` file.
- Semantic uniqueness: one AdditionalTools type, one namespace per function input/output interface, one AdditionalTools branch per input/output union, one index export, one queued variant; all three encrypted fields retained.
- Scratch compilation: `bun VERIFY/vnext/node_modules/typescript/bin/tsc -p W/task-C07-codec-merged-typecheck/tsconfig.json` exit 0. This compiles copied full protocols source with only the two merged files replaced, frozen provider-codex full source/tests via read-only absolute includes, and scratch contracts. Package paths redirect protocols imports to scratch; node_modules are read-only symlinks to installed verify dependencies.
- `contracts.ts` checks permissive role/extension/absent-role carrier, clean developer nullable-ID carrier, input/output unions, encrypted input/output/done fields, queued echo fields, plus conditional type assertions proving both original shapes assign to the merged type and the merged type assigns to their union.
- Initial scratch compile lacked package-local dependency resolution; corrected only the scratch `protocols/node_modules` symlink and compilation passed. No product dependency changes.
- This is affected-contract compilation and reversible integration proof, not a claim of full combined dirty-worktree CI. Root owns full temporary combined validation and final integration.
