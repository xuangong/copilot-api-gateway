import { GITHUB_API_BASE_URL } from "~/config/constants"
import { standardHeaders } from "~/config/headers"
import { HTTPError } from "~/lib/error"
import { fetchWithRetry } from "~/lib/fetch-retry"

export interface GitHubUser {
  login: string
  id: number
  name?: string
  email?: string
}

export async function getGitHubUser(githubToken: string): Promise<GitHubUser> {
  const response = await fetchWithRetry(`${GITHUB_API_BASE_URL}/user`, {
    headers: {
      authorization: `token ${githubToken}`,
      ...standardHeaders(),
    },
  })

  if (!response.ok) throw new HTTPError("Failed to get GitHub user", response)

  return (await response.json()) as GitHubUser
}

export interface CopilotUser {
  [key: string]: string | number | boolean | null | undefined
}

export async function getCopilotUser(githubToken: string): Promise<CopilotUser> {
  const response = await fetchWithRetry(
    `${GITHUB_API_BASE_URL}/copilot_internal/user`,
    {
      headers: {
        authorization: `token ${githubToken}`,
        ...standardHeaders(),
      },
    },
  )

  if (!response.ok) throw new HTTPError("Failed to get Copilot user", response)

  return (await response.json()) as CopilotUser
}
