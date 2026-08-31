/**
 * Copilot data-plane HTTP headers builder.
 *
 * The header set mirrors a real GitHub Copilot Chat client exactly. Both
 * directions matter: a missing canonical header is as much of a tell as an
 * extra one, because the upstream can cross-check them against each other.
 * Never add gateway/operator attribution here.
 *
 * Mirrors copilot-gateway/packages/provider-copilot/src/auth.ts.
 */
import {
  EDITOR_PLUGIN_VERSION,
  EDITOR_VERSION,
  USER_AGENT,
  COPILOT_API_VERSION,
} from "./account-type"

/**
 * Process-stable device id. A real editor install has exactly one for its
 * whole lifetime; minting a fresh one per request would show the upstream
 * "device count == request count", which is itself the shape of a proxy.
 *
 * On Workers this is per-isolate, matching the reference implementation. That
 * reads as several machines running the same plugin — a plausible shape.
 */
let editorDeviceId: string | null = null
const getEditorDeviceId = (): string => (editorDeviceId ??= crypto.randomUUID())

export const copilotHeaders = (
  copilotToken: string,
  vision: boolean = false,
) => {
  // One interaction is one task, so the reference sends the same uuid as both
  // x-request-id and x-agent-task-id. Two different values would claim this
  // request belongs to some other task we never opened.
  const requestId = crypto.randomUUID()

  const headers: Record<string, string> = {
    Authorization: `Bearer ${copilotToken}`,
    "content-type": "application/json",
    "accept-encoding": "identity", // Disable compression - Workers fetch doesn't auto-decompress for streaming
    "copilot-integration-id": "vscode-chat",
    "editor-version": EDITOR_VERSION,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "editor-device-id": getEditorDeviceId(),
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-agent",
    "x-interaction-type": "conversation-agent",
    "x-github-api-version": COPILOT_API_VERSION,
    "x-request-id": requestId,
    "x-agent-task-id": requestId,
    "x-vscode-user-agent-library-version": "electron-fetch",
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}
