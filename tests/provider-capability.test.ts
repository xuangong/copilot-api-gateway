import { test, expect } from "bun:test"
import type { ModelProvider } from "~/providers/types"
import type { EndpointKey } from "~/protocols/common"

test("ModelProvider interface declares supportedEndpoints and fetch()", () => {
  // Compile-time only: a value satisfying the interface must have both.
  const stub: Pick<ModelProvider, "supportedEndpoints" | "fetch"> = {
    supportedEndpoints: ["chat_completions"] as readonly EndpointKey[],
    fetch: async () => new Response("ok"),
  }
  expect(stub.supportedEndpoints).toContain("chat_completions")
})
