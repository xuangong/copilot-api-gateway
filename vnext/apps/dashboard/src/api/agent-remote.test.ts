import { expect, test } from "bun:test"
import { ApiError } from "./client"
import { remoteReauthenticationUrl } from "./agent-remote"

test("sharing reauthentication exposes only the current Gateway's validated login URL", () => {
  const origin = "https://gateway.example"
  const error = (loginUrl: string, status = 403) => new ApiError(status, { code: "reauthentication_required", loginUrl }, "Recent authentication is required")
  expect(remoteReauthenticationUrl(error(`${origin}/agent-remote?reauthenticate=1&host=host_1`), origin)).toBe(`${origin}/agent-remote?reauthenticate=1&host=host_1`)
  for (const url of ["https://evil.example/agent-remote?reauthenticate=1", `${origin}/dashboard`, `${origin}/agent-remote?reauthenticate=1&returnTo=https://evil.example`, `${origin}/agent-remote?reauthenticate=1&host=%22evil`, `${origin}/agent-remote?reauthenticate=0`]) {
    expect(remoteReauthenticationUrl(error(url), origin)).toBeUndefined()
  }
  expect(remoteReauthenticationUrl(error(`${origin}/agent-remote?reauthenticate=1`, 400), origin)).toBeUndefined()
}, 5000)
