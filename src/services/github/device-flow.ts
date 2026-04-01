import {
  GITHUB_API_BASE_URL,
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  GITHUB_APP_SCOPES,
} from "~/config/constants"
import { standardHeaders } from "~/config/headers"
import { HTTPError } from "~/lib/error"
import { fetchWithRetry } from "~/lib/fetch-retry"

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export async function getDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetchWithRetry(
    `${GITHUB_BASE_URL}/login/device/code`,
    {
      method: "POST",
      headers: standardHeaders(),
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: GITHUB_APP_SCOPES,
      }),
    },
  )

  if (!response.ok) throw new HTTPError("Failed to get device code", response)

  return (await response.json()) as DeviceCodeResponse
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
): Promise<string> {
  const sleepDuration = (deviceCode.interval + 1) * 1000
  console.log(`Polling access token with interval of ${sleepDuration}ms`)

  while (true) {
    const response = await fetchWithRetry(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    )

    if (!response.ok) {
      console.error(`Failed to poll access token: ${await response.text()}`)
      await sleep(sleepDuration)
      continue
    }

    const json = (await response.json()) as { access_token?: string }

    if (json.access_token) {
      return json.access_token
    }

    await sleep(sleepDuration)
  }
}
