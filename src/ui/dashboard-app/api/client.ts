// Thin fetch wrapper. All dashboard API calls go through here so we have
// one place to add credentials, parse JSON, and surface errors as exceptions.

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message)
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT"
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  signal?: AbortSignal
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, signal } = opts

  let url = path
  if (query) {
    const usp = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) usp.set(k, String(v))
    }
    const qs = usp.toString()
    if (qs) url += (path.includes("?") ? "&" : "?") + qs
  }

  const headers: Record<string, string> = {}
  let init: RequestInit = { method, credentials: "include", signal }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(body)
  }
  init.headers = headers

  const resp = await fetch(url, init)
  const text = await resp.text()
  let parsed: unknown = undefined
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!resp.ok) {
    const msg =
      (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : null) ?? `HTTP ${resp.status}`
    throw new ApiError(resp.status, parsed, msg)
  }

  return parsed as T
}
