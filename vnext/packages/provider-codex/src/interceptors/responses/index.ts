// Codex-only Responses workarounds. The chain runs inside CodexProvider.fetch;
// the gateway main flow never observes that codex has its own boundary chain.
//
// Order rationale: no interceptor reads a field another writes, so order is
// positional only. `withSystemRewrittenToDeveloper` touches `input[].role`,
// which neither of the others reads or writes.
import type { CopilotInterceptor } from "@vibe-llm/protocols/common"
import { codexModelUsesResponsesLite } from "../../models"
import { withDefaultInstructions } from "./with-default-instructions"
import { withSystemRewrittenToDeveloper } from "./with-system-rewritten-to-developer"
import { withUnsupportedFieldsStripped } from "./with-unsupported-fields-stripped"

export const codexResponsesBoundary: readonly CopilotInterceptor[] = [
  withDefaultInstructions,
  withSystemRewrittenToDeveloper,
  withUnsupportedFieldsStripped,
]

// Lite models accept an empty top-level `instructions`: base instructions ride
// in a tagged developer input item when the caller supplies one, so injecting
// the neutral default would be re-encoded as a spurious developer message.
// Adapted from reference copilot-gateway 3cb6120c9 (#543).
// https://github.com/openai/codex/blob/0462dcc062b822bb8fff16cc31ce6eeab69823b9/codex-rs/core/src/client.rs#L902-L938
export const codexResponsesBoundaryFor = (
  model: { id: string; providerData?: unknown },
): readonly CopilotInterceptor[] =>
  codexModelUsesResponsesLite(model)
    ? codexResponsesBoundary.filter(interceptor => interceptor !== withDefaultInstructions)
    : codexResponsesBoundary
