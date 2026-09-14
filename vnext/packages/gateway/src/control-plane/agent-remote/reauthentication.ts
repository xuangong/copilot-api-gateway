// Only these launch parameters can survive an OAuth roundtrip.
export function agentRemoteReturnPath(value: string): string | undefined {
  let url: URL
  try { url = new URL(value, "https://agent-remote.invalid") }
  catch { return undefined }
  if (url.origin !== "https://agent-remote.invalid" || url.pathname !== "/agent-remote" || url.hash || !value.startsWith("/agent-remote")) return undefined
  const params = new URLSearchParams()
  for (const key of url.searchParams.keys()) if (key !== "challenge" && key !== "host") return undefined
  for (const [key, pattern] of [["challenge", /^[A-Za-z0-9_-]{43}$/], ["host", /^[A-Za-z0-9_-]{1,256}$/]] as const) {
    const values = url.searchParams.getAll(key)
    if (values.length > 1 || (values[0] !== undefined && !pattern.test(values[0]))) return undefined
    if (values[0]) params.set(key, values[0])
  }
  return `/agent-remote${params.size ? `?${params}` : ""}`
}
