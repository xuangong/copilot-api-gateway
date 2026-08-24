// Codex-only Responses workarounds. The chain runs inside CodexProvider.fetch;
// the gateway main flow never observes that codex has its own boundary chain.
//
// Order rationale: no interceptor reads a field another writes, so order is
// positional only. `withSystemRewrittenToDeveloper` touches `input[].role`,
// which neither of the others reads or writes.
import type { CopilotInterceptor } from "@vibe-llm/protocols/common"
import { withDefaultInstructions } from "./with-default-instructions"
import { withSystemRewrittenToDeveloper } from "./with-system-rewritten-to-developer"
import { withUnsupportedFieldsStripped } from "./with-unsupported-fields-stripped"

export const codexResponsesBoundary: readonly CopilotInterceptor[] = [
  withDefaultInstructions,
  withSystemRewrittenToDeveloper,
  withUnsupportedFieldsStripped,
]
