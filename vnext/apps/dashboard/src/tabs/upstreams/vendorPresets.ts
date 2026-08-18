/**
 * Ready-made `custom` upstream configurations for the vendors we've verified.
 *
 * Hand-filling a custom upstream means getting a base URL, a path override
 * table and a vendor flag all right at once; every one of those has bitten us
 * in production. A preset seeds the form with a known-good combination and
 * leaves only the API key to type.
 *
 * Everything here is a *starting point* — the form stays fully editable, so a
 * vendor changing a path doesn't lock anyone out.
 *
 * All presets authenticate with `bearer`. These vendors accept
 * `Authorization: Bearer` on both their OpenAI and Anthropic surfaces, so a
 * single upstream can serve both. `anthropic` (x-api-key) remains available
 * manually for backends that require it.
 */

export interface VendorPreset {
  id: string
  /** Vendor names are proper nouns; only the note is translated. */
  label: string
  /** i18n key for a caveat shown above the form. */
  noteKey?: string
  name: string
  baseUrl: string
  endpoints: string[]
  pathOverrides: Record<string, string>
  /** Blank means "probe `${baseUrl}/models`". */
  modelsEndpoint: string
  flagOverrides: Record<string, boolean>
  modelsText: string
}

export const VENDOR_PRESETS: readonly VendorPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    endpoints: ["chat_completions", "messages"],
    pathOverrides: {
      chat_completions: "/v1/chat/completions",
      messages: "/anthropic/v1/messages",
    },
    modelsEndpoint: "https://api.deepseek.com/v1/models",
    flagOverrides: { "vendor-deepseek": true },
    modelsText: "",
  },
  {
    id: "glm",
    label: "GLM (z.ai)",
    name: "GLM",
    baseUrl: "https://api.z.ai/api/paas/v4",
    endpoints: ["chat_completions"],
    pathOverrides: {},
    modelsEndpoint: "",
    flagOverrides: { "reasoning-content-dialect": true },
    modelsText: "glm-4.6\nglm-4.5-air",
  },
  {
    id: "glm-coding",
    label: "GLM Coding Plan",
    noteKey: "dash.presetNoteGlmCoding",
    name: "GLM Coding",
    baseUrl: "https://api.z.ai",
    endpoints: ["chat_completions", "responses", "messages"],
    pathOverrides: {
      chat_completions: "/api/coding/paas/v4/chat/completions",
      responses: "/api/v1/responses",
      messages: "/api/anthropic/v1/messages",
    },
    modelsEndpoint: "",
    flagOverrides: { "reasoning-content-dialect": true },
    modelsText: "glm-4.6\nglm-4.5-air",
  },
  {
    id: "qwen",
    label: "Qwen (pay-as-you-go)",
    noteKey: "dash.presetNoteQwen",
    name: "Qwen",
    baseUrl: "https://WORKSPACE_ID.cn-beijing.maas.aliyuncs.com",
    endpoints: ["chat_completions", "messages"],
    pathOverrides: {
      chat_completions: "/compatible-mode/v1/chat/completions",
      messages: "/apps/anthropic/v1/messages",
    },
    modelsEndpoint: "",
    flagOverrides: { "vendor-qwen": true, "reasoning-content-dialect": true },
    modelsText: "qwen3-max\nqwen3-coder-plus",
  },
  {
    id: "qwen-coding-openai",
    label: "Qwen Coding · OpenAI side",
    noteKey: "dash.presetNoteQwenCoding",
    name: "Qwen Coding (OpenAI)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    endpoints: ["chat_completions"],
    pathOverrides: {},
    modelsEndpoint: "",
    flagOverrides: { "vendor-qwen": true, "reasoning-content-dialect": true },
    modelsText: "qwen3-coder-plus",
  },
  {
    id: "qwen-coding-anthropic",
    label: "Qwen Coding · Anthropic side",
    noteKey: "dash.presetNoteQwenCoding",
    name: "Qwen Coding (Anthropic)",
    // The bare `dashscope.aliyuncs.com/apps/anthropic` host answers 403 —
    // the coding plan is served from its own subdomain.
    baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    endpoints: ["messages"],
    pathOverrides: { messages: "/v1/messages" },
    modelsEndpoint: "",
    flagOverrides: { "vendor-qwen": true, "reasoning-content-dialect": true },
    modelsText: "qwen3-coder-plus",
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    noteKey: "dash.presetNoteKimi",
    name: "Kimi",
    baseUrl: "https://api.moonshot.ai",
    // `messages_count_tokens` is left off on purpose: Moonshot answers 404.
    endpoints: ["chat_completions", "messages"],
    pathOverrides: {
      chat_completions: "/v1/chat/completions",
      messages: "/anthropic/v1/messages",
    },
    modelsEndpoint: "https://api.moonshot.ai/v1/models",
    flagOverrides: { "vendor-kimi": true, "reasoning-content-dialect": true },
    modelsText: "",
  },
]

export function findPreset(id: string | undefined): VendorPreset | undefined {
  return id ? VENDOR_PRESETS.find((p) => p.id === id) : undefined
}
