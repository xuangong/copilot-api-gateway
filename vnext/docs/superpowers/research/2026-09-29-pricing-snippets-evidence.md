# C10 pricing and D09 snippet evidence

Retrieved 2026-09-29. Read-only audit; no application edits, paid inference, live client configuration changes, commits or deployment. Worktree HEAD observed: `e4b2d04f29c4a37db0ec0afc477f595b5cb3eeed` (other workers remain active).

## Sources and reproducibility

- Official [GitHub Copilot model pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing), fetched through [GitHub's article-body endpoint](https://docs.github.com/api/article/body?pathname=/en/copilot/reference/copilot-billing/models-and-pricing). Parent's `/tmp/copilot-model-pricing.txt` and this audit's fresh `/tmp/copilot-model-pricing-audit.txt` are byte-identical: 18,929 bytes; SHA-256 `e281354e4d14447d6a11b520b4ba79163e70e3f5dfeadc506273da489c0fb173`.
- Official [Claude Code changelog pinned to 7779afb](https://github.com/anthropics/claude-code/blob/7779afb12e3635f46f56ec823979d68350ae000b/CHANGELOG.md). GitHub API reports commit date 2026-09-25T21:49:55Z. Download: `/tmp/d09-source-2.txt`, SHA-256 `ae8f617c42850f48b143f5c5b0aae6892470afe02e13b050d7cb72e42adb394a`; main and pinned downloads match.
- Local official Claude Code executable `/opt/homebrew/bin/claude`: `claude --version` returns **2.1.247**. Its symlink directory says 2.1.128, so do not infer the running version from the directory. Binary SHA-256 `1a56ae4cd171ba7839fc2b03d558022ffaebb5693be532d8f3c344731063e979`. Read embedded JavaScript only; no model request was made.
- Official model-config HTML and Markdown both returned HTTP 403 through urllib. Search results identify the official page but are not used as sole evidence for a variable or its behavior. No third-party issue comment is used as product documentation.

## C10: confirmed differences only

Current source: `vnext/packages/provider-copilot/src/pricing.ts`. Rates below are USD per one million tokens, ordered **input / cache read / cache write / output**; dash means no cache-write rate is published. A Bun probe imported the actual `pricingForCopilotModelKey` and catalog functions to establish current lookup results; it did not modify state.

| Exact lookup/model | Current result | Official result | Narrow implementation |
| --- | --- | --- | --- |
| `gpt-5.6-sol`, Default | 2 / 0.2 / 2.5 / 10 | **4 / 0.4 / 5 / 20** | Update the default row and remove the expired September 3 promotion explanation. This changes future usage snapshots, not prior stored rows. |
| `gpt-5.6-sol`, Long context, input >272,000 | 4 / 0.4 / 5 / 15 | **8 / 0.8 / 10 / 30** | Update displayed band while retaining the existing default-only billing behavior. |
| `claude-opus-5.5`, also `claude-opus-5-5` | 5 / 0.5 / 6.25 / 25 (falls through broad Opus 5 regex) | **4 / 0.2 / 5 / 20** | Add exact Opus 5.5 dot/dash matcher before or instead of the broad family regex; keep Opus 5 at its separately documented 5 / 0.5 / 6.25 / 25. |
| `claude-fable-5.1`, also `claude-fable-5-1` | 10 / 1 / 12.5 / 50 (broad Fable 5 regex) | **10 / 0.25 / 12.5 / 50** | Add exact Fable 5.1 matcher; keep Fable 5 cache read at 1. |
| GPT-6 Astra, Long context, input >272,000 | No second tier | **20 / 2 / 25 / 75** | Add the published display tier. Existing default 10 / 1 / 12.5 / 50 already agrees. Replace the old user-catalog-only provenance comment with current official evidence. |
| `gpt-6-sol`, Default / Long >272,000 | `null` | **2 / 0.2 / 2.5 / 10**; **4 / 0.4 / 5 / 15** | Exact lookup-only addition with published display bands. |
| `gpt-6-luna`, Default / Long >272,000 | `null` | **0.1 / 0.01 / 0.125 / 0.5**; **0.2 / 0.02 / 0.25 / 0.75** | Exact lookup-only addition; preserve the 0.125 decimal without rounding. |
| `gemini-3.8-flash` | `null` | **0.75 / 0.075 / — / 3.75** | Exact addition using the existing Gemini promotion constant. Official promotion ends **2026-12-31**; do not guess the later rate. |
| `grok-4.7`, Default / Long >200,000 | `null` | **2 / 0.5 / — / 6**; **4 / 1 / — / 12** | Exact addition reusing the published Grok band values, without a prefix matcher. |
| Claude Opus 4.8 fast mode | `claude-opus-4.8-fast` lookup is `null` | **10 / 1 / 12.5 / 50** | The price is verified; fast raw ID/catalog selection and response tier semantics are C05. Do not silently enable a fast lane or assume every endpoint supports it. A pricing-only exact raw-key entry must be described separately from C05 completion. |

The pricing page publishes human model names, not canonical API IDs. The candidate new lookup IDs above follow the repository/reference naming contract and are only lookup entries; this evidence does **not** establish that a live tenant advertises those IDs. Adding prices must not inject models into inference discovery. Existing exact Sol/Opus/Fable lookups are independently demonstrated by the runtime probe.

Other already-listed official rows inspected agree, including GPT-5.6 Terra/Luna, GPT-5.4/5.5, GPT-5.4 mini/nano, Haiku 4.5, Sonnet 4/4.6/5, Opus 4.7/4.8/5, Fable 5, Gemini 3.5/3.6/3.7 Flash, MAI-Code-1.1-Flash, Grok 4.5/4.6 and Kimi K2.7 Code/K3. Do not churn them as part of this correction.

### Matching boundaries

The actual current lookup also prices synthetic, unpublished IDs: `claude-opus-5.9`, `claude-fable-5.9`, `grok-4.50`, and `kimi-k30`. This proves prefix/family overmatching, not that these models exist. A safe C10 follow-up tightens the documented version matchers and adds negative tests. Preserve explicitly supported raw effort/context/date aliases through the existing `copilotPublicModelId` and date normalization; do not indiscriminately anchor every legacy pattern without checking its known aliases.

`pricing.ts` calls `tiers[0]` exclusively. `gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts:58` snapshots provider pricing by resolved `modelKey`. This audit does not authorize implementing long-context or service-tier-aware billing by picking another tier opportunistically. That needs an explicit accounting contract, including cached-token context thresholds and multi-call usage attribution.

Keep operator-supplied custom prices intact: `provider-custom/src/provider.ts:149-150` uses manual pricing before auto-discovery pricing. Restrict edits to Copilot fallback prices and related fixtures; do not rewrite stored usage, provider configs or custom costs.

Recommended tests in `provider-copilot/src/__tests__/pricing.test.ts`:

1. Replace the stale Sol promotional expectation with the newly retrieved official values; preserve default-tier and long-tier assertions.
2. Add exact Opus 5 versus 5.5 and Fable 5 versus 5.1 assertions for dot/dash forms, plus their known raw variant forms.
3. Add new exact entries and negative unknown-version/suffix fixtures.
4. Update the Astra display-tier assertion; keep the default billing value unchanged.
5. Replace brittle global row-count expectations only with a clear intended current-row inventory, without removing pricing invariants. Historical models absent from today's page should keep historical lookup rates; absence is not evidence of a new rate.
6. Advance `verifiedOn` to 2026-09-29 only for the audited official catalog corrections, documenting retained historical/internal rows separately. The internal Sol Fast row is not verified by today's public page and must not be doubled merely because normal Sol rose.

## D09: verified variables and compatibility boundary

| Variable | First-party/runtime evidence | Safe implementation |
| --- | --- | --- |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Changelog 1.0.88 introduces the Opus/Sonnet defaults. Local 2.1.247 function `Jy()` reads this env first; alias resolver `jK()` sends `opus` to `Jy()`. | Add an independently selected Opus tier value to shell and settings snippets. |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Same official introduction; local `Ev()` reads this env first and `jK()` sends `sonnet`/`opusplan` to it. | Add independent Sonnet selection. Do not force it to the primary model. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Changelog 2.0.17 documents the Haiku override; local `gEH()` reads it first and `jK()` sends `haiku` to it. | Add independent Haiku selection. Existing `ANTHROPIC_SMALL_FAST_MODEL` remains a separate override path in the installed executable, so preserving it is justified. |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | Official changelog **2.1.260** documents a fix for Fable agent pins losing `[1m]`; therefore the variable and Fable alias are supported in that release. Local **2.1.247 has zero occurrences** of this variable, and its alias switch has no Fable case. | It is now evidenced, but not supported by the inspected installed version. Either implement the three broadly verified tiers now, or add Fable as an explicitly version-qualified optional tier for 2.1.260+; do not promise that the user's current local CLI honors it. This is a verified-at version, not a claim that 2.1.260 first introduced it. |

The official changelog alone is enough to establish Fable's versioned existence; reference `682289834` was not needed as sole evidence. No CLI upgrade is part of this task.

### Snippet behavior to preserve

- Existing files: `apps/dashboard/src/tabs/keys/configSnippets.ts`, `ConfigurationPanel.tsx`, `config-snippets.test.ts`, and `state/models.ts` for eligible model lists.
- Preserve the primary `ANTHROPIC_MODEL` and existing small/fast override behavior; default-tier variables control alias resolution and do not supersede an explicit main model choice.
- Preserve exact mapped aliases, including names that resemble composite effort/context suffixes. Existing tests already enforce this.
- A single global custom-header/effort setting cannot express different tier-specific efforts or context options. Do not silently decompose every tier and overwrite the shared headers from the last tier. Keep tier identity explicit, or restrict per-tier choices to an already-defined representable form and test it.
- Snippet output is a mergeable settings fragment. Do not write to a real `~/.claude/settings.json` or change unrelated settings. JSON parsing and shell value round-trip tests may use temporary files and synthetic values.
- The installed source proves alias reads, not end-to-end gateway network behavior for every client release. No live agent or paid request was launched.

## Proposed bounded delivery

C10 can correct Sol/Opus 5.5/Fable 5.1 now, add independently verified default rates/display bands as exact lookup entries, and tighten only the demonstrated overmatching with explicit known-alias tests. Keep C05 fast-tier selection and long-context billing separate.

D09 can safely deliver Opus/Sonnet/Haiku selections now; Fable has sufficient official evidence only with the documented client-version boundary. No runtime or authorization dependency blocks the three-tier snippet work.

## C10 implementation record (2026-09-29)

The Copilot fallback table was updated from the public rows above. Its `verifiedOn` date applies to those audited public prices; retained historical billing-only values and the separately sourced internal Sol Fast rate are not claims about the current public page. Exact lookup entries do not add models to inference discovery. The Opus 4.8 fast raw-key price is a pricing lookup only; model selection and endpoint semantics remain C05. Long-context tiers are display metadata, while billing continues to use the default tier. The gateway's code-derived model catalog revision advances from 2 to 3 to reject earlier L2 snapshots; the configuration revision remains independent. No stored usage or operator-supplied pricing was changed.
