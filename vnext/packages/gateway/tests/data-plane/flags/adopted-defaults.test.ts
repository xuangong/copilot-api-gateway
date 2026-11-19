/**
 * Provider flag defaults adopted from the reference (copilot-gateway), with
 * the reason each default exists. Changing one is a policy decision: update
 * the reason here, not just the expectation.
 */
import { expect, test } from 'bun:test'
import type { UpstreamKind } from '@vibe-llm/protocols/common'
import { defaultsForUpstream } from '@vibe-llm/protocols/flags'

const KINDS: UpstreamKind[] = ['copilot', 'azure', 'codex', 'claude-code', 'custom', 'sdf', 'loki']
const enabledFor = (flag: string) => KINDS.filter(kind => defaultsForUpstream(kind).has(flag))

// #572 (e710cf06b): compaction through the gateway shim yields
// gateway-readable state that survives a later turn on another upstream;
// native compaction yields opaque state only that upstream can read, and this
// gateway cannot decrypt it. Operators can still turn the shim off per
// upstream to use a Responses target's native compaction.
test('the compact shim is on for every provider', () => {
  expect(enabledFor('responses-compact-shim')).toEqual(KINDS)
})

// #614 (c117da8df): Claude accepts inline system messages only at turn
// boundaries; Claude Code and Copilot's Claude models answer 400 otherwise.
// The flag only acts on Anthropic Messages requests, which on Copilot are
// exactly its Claude models.
test('selective inline-system downgrade is on for Claude Code and Copilot', () => {
  expect(enabledFor('demote-disallowed-system-to-user')).toEqual(['copilot', 'claude-code'])
})

// #601 (0fbffdcd0): Copilot answers 400 to store:true. Other providers keep
// the caller's value (Codex's request body pins store:false itself).
test('forcing store:false is on for Copilot only', () => {
  expect(enabledFor('transform-force-store-false')).toEqual(['copilot'])
})
