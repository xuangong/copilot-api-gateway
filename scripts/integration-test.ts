#!/usr/bin/env bun
/**
 * Integration test runner
 * Starts the server and runs SDK integration tests
 *
 * Prerequisites:
 * 1. Run `bun run auth` to get GitHub token
 * 2. Run `wrangler kv:key put --local --binding=KV github_token "YOUR_TOKEN"` to save token
 */

import { spawn, type Subprocess } from "bun"

const PORT = 41414
const BASE_URL = `http://localhost:${PORT}`
const MAX_WAIT_TIME = 30000 // 30 seconds
const POLL_INTERVAL = 500

async function checkTokenExists(): Promise<boolean> {
  // Check if token is in environment or local KV
  if (process.env.GITHUB_TOKEN) {
    return true
  }

  // Try to check local KV by making a test request
  // We'll rely on server startup check instead
  return true
}

async function waitForServer(): Promise<boolean> {
  const startTime = Date.now()

  while (Date.now() - startTime < MAX_WAIT_TIME) {
    try {
      const response = await fetch(`${BASE_URL}/health`)
      if (response.ok) {
        return true
      }
    } catch {
      // Server not ready yet
    }
    await Bun.sleep(POLL_INTERVAL)
  }

  return false
}

async function checkServerReady(): Promise<boolean> {
  // Check health and then try a simple API call to verify token
  try {
    const response = await fetch(`${BASE_URL}/v1/models`)
    if (response.ok) {
      return true
    }
    const data = await response.json() as { error?: { message?: string } }
    if (data.error?.message?.includes("token not found")) {
      console.error("\n❌ GitHub Token not configured!")
      console.error("\nTo configure:")
      console.error("  1. Run: bun run auth")
      console.error("  2. Run: wrangler kv:key put --local --binding=KV github_token \"YOUR_TOKEN\"")
      console.error("")
      return false
    }
    return false
  } catch {
    return false
  }
}

async function runTests(testPattern?: string): Promise<number> {
  const args = ["test"]

  if (testPattern) {
    args.push(testPattern)
  } else {
    args.push("./tests/sdk-anthropic.test.ts", "./tests/sdk-openai.test.ts", "./tests/sdk-web-search.test.ts")
  }

  const proc = spawn({
    cmd: ["bun", ...args],
    env: {
      ...process.env,
      TEST_API_BASE_URL: BASE_URL,
    },
    stdout: "inherit",
    stderr: "inherit",
  })

  return proc.exited
}

async function main() {
  const testPattern = process.argv[2] // Optional: specific test file

  console.log(`Starting server on port ${PORT}...`)

  // Start the server
  const server = spawn({
    cmd: ["bun", "run", "wrangler", "dev", "--port", String(PORT)],
    stdout: "inherit",
    stderr: "inherit",
  })

  let exitCode = 1

  try {
    console.log("Waiting for server to be ready...")

    const serverReady = await waitForServer()

    if (!serverReady) {
      console.error("Server failed to start within timeout")
      server.kill()
      process.exit(1)
    }

    console.log("Server is ready!")

    // Check if token is configured
    const tokenOk = await checkServerReady()
    if (!tokenOk) {
      server.kill()
      process.exit(1)
    }

    console.log("Token verified!")
    console.log("Running integration tests...\n")

    exitCode = await runTests(testPattern)
  } finally {
    console.log("\nStopping server...")
    server.kill()
  }

  process.exit(exitCode)
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
