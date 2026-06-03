import {
  EDITOR_PLUGIN_VERSION,
  USER_AGENT,
  API_VERSION,
} from "./constants"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

export const copilotHeaders = (
  copilotToken: string,
  vision: boolean = false,
) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${copilotToken}`,
    "content-type": "application/json",
    "accept-encoding": "identity", // Disable compression - Workers fetch doesn't auto-decompress for streaming
    "copilot-integration-id": "vscode-chat",
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-panel",
    "x-github-api-version": API_VERSION,
    "x-request-id": crypto.randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const githubHeaders = (githubToken: string) => ({
  ...standardHeaders(),
  "accept-encoding": "identity", // Disable compression for Workers compatibility
  authorization: `token ${githubToken}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})
