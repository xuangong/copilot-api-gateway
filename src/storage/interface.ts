// Storage interface for KV operations
export interface IStorage {
  get(key: string): Promise<string | null>
  set(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>
  delete(key: string): Promise<void>
}

// Storage keys
export const STORAGE_KEYS = {
  GITHUB_TOKEN: "github_token",
  COPILOT_TOKEN: "copilot_token",
  COPILOT_TOKEN_EXPIRES: "copilot_token_expires",
  ENGINE_STATE: "engine_state",
  LANGSEARCH_KEY: "langsearch_api_key",
  TAVILY_KEY: "tavily_api_key",
} as const
