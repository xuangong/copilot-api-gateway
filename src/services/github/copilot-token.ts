import { GITHUB_API_BASE_URL } from "~/config/constants"
import { githubHeaders } from "~/config/headers"
import { HTTPError } from "~/lib/error"
import { fetchWithRetry } from "~/lib/fetch-retry"

export interface CopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}

export async function getCopilotToken(
  githubToken: string,
): Promise<CopilotTokenResponse> {
  const response = await fetchWithRetry(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(githubToken),
    },
  )

  if (!response.ok)
    throw new HTTPError("Failed to get Copilot token", response)

  return (await response.json()) as CopilotTokenResponse
}
