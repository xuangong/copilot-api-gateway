// Codex-only Responses workarounds. The chain runs inside CodexProvider.fetch;
// the gateway main flow never observes that codex has its own boundary chain.
//
// Order rationale: neither interceptor reads a field the other writes, so
// order is positional only.
import type { CopilotInterceptor } from "@vibe-llm/protocols/common"
import { withDefaultInstructions } from "./with-default-instructions"
import { withUnsupportedFieldsStripped } from "./with-unsupported-fields-stripped"

export const codexResponsesBoundary: readonly CopilotInterceptor[] = [
  withDefaultInstructions,
  withUnsupportedFieldsStripped,
]
