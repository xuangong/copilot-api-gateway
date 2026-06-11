/**
 * Copilot HTTP headers builder.
 *
 * Verbatim copy of the `copilotHeaders` helper from
 * apps/gateway/src/shared/config/headers.ts. Only the Copilot-specific
 * builder is duplicated; gateway keeps the original for `standardHeaders`
 * and `githubHeaders` which are not part of this package's surface.
 */
import { EDITOR_PLUGIN_VERSION, USER_AGENT, API_VERSION } from "./account-type"

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
