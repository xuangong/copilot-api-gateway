export const LOKI_PROFILE_ID = "loki-df-v1" as const
export const LOKI_BASE_URL = "https://loki.delve.office.com/api/v1/llmapi"
export const LOKI_HEADERS = {
  "X-ClientType": "Copilot",
  "X-ClientFeature": "LlmApiProxy",
  "X-ClientScenario": "Code",
  "X-HostPlatform": "Windows",
  "X-Llm-Api-Version": "2026-09-22",
} as const
