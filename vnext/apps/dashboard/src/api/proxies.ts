// Proxy node pool + backoff inspection. Everything here is admin-only except
// listProxyOptions, which is a label-only view readable by any authenticated
// user (no URLs — those embed the proxy credential).
// Keep in sync with packages/gateway/src/control-plane/proxies/routes.ts
// (shapes mirror packages/proxy-repo/src/types.ts field-for-field).
import { api } from "./client"

export interface ProxyRecord {
  id: string
  name: string
  url: string
  createdAt: string
  updatedAt: string
  /** Per-proxy dial deadline in seconds; null means "use the dialer default". */
  dialTimeoutSeconds: number | null
}

export interface ProxyBackoffRow {
  proxyId: string
  upstreamId: string
  failCount: number
  /** Seconds since epoch. */
  expiresAt: number
  lastError: string | null
  /** Seconds since epoch. */
  lastErrorAt: number | null
}

export function listProxies(): Promise<{ proxies: ProxyRecord[] }> {
  return api<{ proxies: ProxyRecord[] }>("/api/proxies")
}

export function createProxy(body: {
  name: string
  url: string
  dialTimeoutSeconds?: number | null
}): Promise<{ proxy: ProxyRecord }> {
  return api<{ proxy: ProxyRecord }>("/api/proxies", { method: "POST", body })
}

export function patchProxy(
  id: string,
  body: { name?: string; url?: string; dialTimeoutSeconds?: number | null },
): Promise<{ proxy: ProxyRecord }> {
  return api<{ proxy: ProxyRecord }>(`/api/proxies/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  })
}

// Throws ApiError(409, { error, upstreamIds }) when the node is still
// referenced by an upstream's fallback list.
export function deleteProxy(id: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/proxies/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export function listBackoffs(): Promise<{ backoffs: ProxyBackoffRow[] }> {
  return api<{ backoffs: ProxyBackoffRow[] }>("/api/proxies/backoffs")
}

export function resetBackoffs(proxyId: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/proxies/${encodeURIComponent(proxyId)}/backoffs`, {
    method: "DELETE",
  })
}

/** 出口探针的锚点。与 gateway 的 ANCHORS 表一一对应。 */
export type ProxyTestAnchor = "ipify" | "aws" | "ident.me-v6"

export type ProxyTestResult = { ok: true; egressIp: string } | { ok: false; error: string }

/**
 * 通过该代理去请求一个外部锚点，回显它看到的出口 IP。
 *
 * 认证错了不会在这一步静默通过：trojan 服务端对错密码会返回伪装网站，
 * TCP/TLS/握手全都"成功"，只有响应体是不是一个合法 IP 能区分。所以
 * 后端校验的是响应内容，前端只需展示结果。
 *
 * 200 与失败共用同一个 body 形状（`ok: false` 也是 200），失败信息在
 * `error` 里；因此这里不靠 HTTP 状态码判断成败。
 */
export function testProxy(body: {
  url: string
  dialTimeoutSeconds?: number | null
  anchor?: ProxyTestAnchor
}): Promise<ProxyTestResult> {
  return api<ProxyTestResult>("/api/proxies/test", { method: "POST", body })
}

/** Label-only pool, readable by any authenticated user (no URLs). */
export interface ProxyOption {
  id: string
  name: string
}

export function listProxyOptions(): Promise<{ proxies: ProxyOption[] }> {
  return api<{ proxies: ProxyOption[] }>("/api/proxies/options")
}
