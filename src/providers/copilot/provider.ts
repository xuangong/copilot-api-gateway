import type { AccountType } from "~/config/constants"
import { callCopilotAPI } from "~/services/copilot/forward"
import { getModels, type ModelsResponse } from "~/services/copilot/models"

import type { ModelProvider, ProviderCallOptions } from "../types"

export interface CopilotProviderConfig {
  copilotToken: string
  accountType: AccountType
  name?: string
}

export class CopilotProvider implements ModelProvider {
  readonly kind = "copilot" as const
  readonly name: string
  private readonly copilotToken: string
  private readonly accountType: AccountType

  constructor(cfg: CopilotProviderConfig) {
    this.copilotToken = cfg.copilotToken
    this.accountType = cfg.accountType
    this.name = cfg.name ?? "copilot"
  }

  getModels(): Promise<ModelsResponse> {
    return getModels(this.copilotToken, this.accountType)
  }

  callChatCompletions(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.call("/chat/completions", payload, opts, "call Chat Completions")
  }

  callResponses(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.call("/responses", payload, opts, "call Responses")
  }

  callMessages(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.call("/v1/messages", payload, opts, "call Messages")
  }

  callMessagesCountTokens(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.call("/v1/messages/count_tokens", payload, opts, "count tokens", { requireModel: false })
  }

  private call(
    endpoint: string,
    payload: Record<string, unknown>,
    opts: ProviderCallOptions,
    defaultOpName: string,
    extra: { requireModel?: boolean } = {},
  ): Promise<Response> {
    return callCopilotAPI({
      endpoint,
      payload,
      operationName: opts.operationName ?? defaultOpName,
      copilotToken: this.copilotToken,
      accountType: this.accountType,
      timeout: opts.timeout,
      extraHeaders: opts.extraHeaders,
      requireModel: extra.requireModel,
    })
  }
}
