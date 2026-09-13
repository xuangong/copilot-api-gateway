import { env } from "@vibe-core/platform"

export interface AgentRemoteConfiguration {
  target: string
  issuer: string
  secret: string
}

function origin(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Agent Remote requires an HTTPS origin or loopback HTTP origin")
  }
  return url.origin
}

export function agentRemoteConfiguration(): AgentRemoteConfiguration | undefined {
  const target = env("AGENT_REMOTE_RELAY_URL")
  const secret = env("AGENT_REMOTE_SIGNING_SECRET")
  const issuer = env("AGENT_REMOTE_ISSUER")
  if (!target || !secret || !issuer) return undefined
  if (new TextEncoder().encode(secret).length < 32) throw new Error("Agent Remote signing secret must contain at least 32 bytes")
  return { target: origin(target), issuer: origin(issuer), secret }
}
