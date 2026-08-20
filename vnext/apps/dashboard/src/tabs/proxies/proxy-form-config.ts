/**
 * Proxies 表单的纯逻辑层：协议枚举、每种协议的默认值与必填字段，以及
 * URL 输入框 ⇄ 结构化字段的双向同步规则。
 *
 * 不 import React —— 这里的规则全部可以用 `bun test` 直接覆盖。
 */
import { formatProxyUri, parseProxyUri } from '@vibe-core/proxy/url'
import type { ProxyConfig } from '@vibe-core/proxy/proxy-config'

/**
 * 表单上的 9 个选项。`http` 在 `ProxyConfig` 里靠 `tls` 布尔区分明文与
 * HTTPS 代理，但在表单上把它拆成两项更直观，所以 FormKind 比
 * `ProxyConfig['kind']` 多一个。
 */
export const FORM_KINDS = [
  'http', 'https', 'socks5', 'ss', 'ss2022', 'trojan', 'vless-tcp', 'vless-ws', 'reality',
] as const

export type FormKind = (typeof FORM_KINDS)[number]

export const DEFAULT_PORTS: Record<FormKind, number> = {
  'http': 8080,
  'https': 443,
  'socks5': 1080,
  'ss': 8388,
  'ss2022': 8388,
  'trojan': 443,
  'vless-tcp': 443,
  'vless-ws': 443,
  'reality': 443,
}

export interface ProxyDraft {
  name: string
  config: ProxyConfig
  /**
   * Sentinel：`null` 表示"以结构化字段为准"，URL 框显示由字段推导出的规范
   * 形态；非 `null` 表示用户正在直接编辑 URL，此时原样回显、不覆盖用户输入。
   * 契约：渲染层在用户改动任一结构化字段时须把它置回 `null`。
   */
  url: string | null
  /** 原始输入，留空表示沿用服务端默认值。 */
  dialTimeoutSeconds: string
}

type Base = { host: string; port: number; name: string }

/** 切换协议时保留 host / port / name，其余字段回到该协议的默认值。 */
export const defaultsFor = (kind: FormKind, base: Base): ProxyConfig => {
  switch (kind) {
  case 'http':
    return { kind: 'http', tls: false, ...base }
  case 'https':
    return { kind: 'http', tls: true, ...base }
  case 'socks5':
    return { kind: 'socks5', ...base }
  case 'ss':
    return { kind: 'ss', method: 'aes-256-gcm', password: '', ...base }
  case 'ss2022':
    return { kind: 'ss2022', method: '2022-blake3-aes-256-gcm', passwordBase64: '', ...base }
  case 'trojan':
    return { kind: 'trojan', password: '', ...base }
  case 'vless-tcp':
    return { kind: 'vless-tcp', uuid: '', ...base }
  case 'vless-ws':
    return { kind: 'vless-ws', uuid: '', path: '/', ...base }
  case 'reality':
    return { kind: 'reality', uuid: '', publicKey: '', serverName: '', ...base }
  }
}

export const formKindOf = (config: ProxyConfig): FormKind =>
  config.kind === 'http' ? (config.tls ? 'https' : 'http') : config.kind

/**
 * 解析成功返回 config，失败返回 null。UI 侧只关心成败，不需要区分错误类型；
 * 这里也是整个 dashboard 唯一调用 `parseProxyUri` 的地方。
 */
export const parseProxyUriSafe = (uri: string): ProxyConfig | null => {
  try {
    return parseProxyUri(uri)
  } catch {
    return null
  }
}

/**
 * URL 框该显示什么。`url === null` 时由结构化字段推导；host 还是空的话
 * `formatProxyUri` 会产出 `trojan://p@:443` 这种缺主机名的半成品，不如直接
 * 显示空串。
 */
export const draftUrl = (d: ProxyDraft): string =>
  d.url ?? (d.config.host.trim() ? formatProxyUri({ ...d.config, name: d.name.trim() }) : '')

export interface DraftIssues {
  name?: string
  url?: string
  dialTimeout?: string
  /** 键是 ProxyConfig 的字段名，值是 i18n key。 */
  config: Record<string, string | undefined>
}

/**
 * 校验草稿，返回 i18n key（不是文案）—— 这样本模块不依赖 i18n 字典，
 * 渲染层拿到 key 自己 `t()`。
 */
export const draftIssues = (d: ProxyDraft): DraftIssues => {
  const issues: DraftIssues = { config: {} }

  if (!d.name.trim()) issues.name = 'dash.proxyErrName'

  // URL 框有内容时校验用户输入的原文；`url === null` 时校验由字段推导出的
  // 那一串 —— 提交和测试发出去的正是它。少了后半条，"每个字段各自合法但拼
  // 起来不是合法 URI" 的组合会穿过前端门禁，只在后端炸成一句通用 400。
  // host 为空时 `draftUrl` 返回空串，此时已有 host 的报错，不必再报一次。
  const url = d.url !== null ? d.url.trim() : draftUrl(d)
  if (url && !parseProxyUriSafe(url)) issues.url = 'dash.proxyErrUrl'

  const t = d.dialTimeoutSeconds.trim()
  if (t && !/^[1-9]\d*$/.test(t)) issues.dialTimeout = 'dash.proxyErrDialTimeout'

  const c = d.config
  if (!c.host.trim()) issues.config.host = 'dash.proxyErrHost'
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) {
    issues.config.port = 'dash.proxyErrPort'
  }

  switch (c.kind) {
  case 'http':
  case 'socks5':
    break
  case 'ss':
    if (!c.password) issues.config.password = 'dash.proxyErrPassword'
    break
  case 'ss2022':
    if (!c.passwordBase64) issues.config.passwordBase64 = 'dash.proxyErrPassword'
    break
  case 'trojan':
    if (!c.password) issues.config.password = 'dash.proxyErrPassword'
    break
  case 'vless-tcp':
    if (!c.uuid.trim()) issues.config.uuid = 'dash.proxyErrUuid'
    break
  case 'vless-ws':
    if (!c.uuid.trim()) issues.config.uuid = 'dash.proxyErrUuid'
    if (!c.path.trim()) issues.config.path = 'dash.proxyErrPath'
    break
  case 'reality':
    if (!c.uuid.trim()) issues.config.uuid = 'dash.proxyErrUuid'
    if (!c.publicKey.trim()) issues.config.publicKey = 'dash.proxyErrPublicKey'
    if (!c.serverName.trim()) issues.config.serverName = 'dash.proxyErrServerName'
    break
  }

  return issues
}

/**
 * 草稿是否可测试。门槛比"可提交"低一格：名称可以为空 —— 测试只拨号，不落库，
 * 名称对拨号没有任何影响，先试通再起名是很自然的顺序。
 */
export const draftIsTestable = (d: ProxyDraft): boolean => {
  const i = draftIssues(d)
  return !i.url && !i.dialTimeout && Object.keys(i.config).length === 0
}

/** 草稿是否可提交：在"可测试"之上再要求名称非空。 */
export const draftIsValid = (d: ProxyDraft): boolean =>
  !draftIssues(d).name && draftIsTestable(d)
