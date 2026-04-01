#!/usr/bin/env bun
/**
 * Local authentication script for GitHub Device Flow
 * This script generates a GitHub token and saves it to local KV storage
 *
 * Usage: bun run scripts/auth.ts
 */

import { getDeviceCode, pollAccessToken, getGitHubUser } from "../src/services/github"

async function main() {
  console.log("Starting GitHub Device Flow authentication...\n")

  // Get device code
  const deviceCode = await getDeviceCode()

  console.log("Please visit the following URL to authenticate:")
  console.log(`\n  ${deviceCode.verification_uri}\n`)
  console.log(`Enter this code: ${deviceCode.user_code}\n`)
  console.log("Waiting for authentication...")

  // Poll for access token
  const accessToken = await pollAccessToken(deviceCode)

  console.log("\nAuthentication successful!")

  // Verify token by getting user info
  const user = await getGitHubUser(accessToken)
  console.log(`Logged in as: ${user.login}`)

  // Output token for manual KV setup
  console.log("\n" + "=".repeat(60))
  console.log("To save the token to local KV storage, run:")
  console.log(`\n  wrangler kv:key put --local --binding=KV github_token "${accessToken}"\n`)
  console.log("Or for production:")
  console.log(`\n  wrangler kv:key put --binding=KV github_token "${accessToken}"\n`)
  console.log("=".repeat(60))
}

main().catch((error) => {
  console.error("Authentication failed:", error.message)
  process.exit(1)
})
