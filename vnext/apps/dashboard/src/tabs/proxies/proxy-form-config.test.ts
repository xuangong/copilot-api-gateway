/**
 * 表单纯逻辑层。这里钉的是三件事：
 *   1. 9 个 FormKind ↔ ProxyConfig 的双向映射（http 按 tls 拆成两个）；
 *   2. `draftUrl` 的 sentinel 语义 —— `url === null` 表示"以结构化字段为准，
 *      URL 框显示由字段推导出的规范形态"；非 null 表示"用户正在直接编辑
 *      URL，原样回显"；
 *   3. 每个协议各自的必填字段。
 */
import { test, expect } from 'bun:test'
import {
  DEFAULT_PORTS,
  FORM_KINDS,
  defaultsFor,
  draftIssues,
  draftUrl,
  formKindOf,
  parseProxyUriSafe,
} from './proxy-form-config.ts'

const base = { host: 'h.example.com', port: 443, name: 'n' }

test('FORM_KINDS 覆盖 9 种形态', () => {
  expect(FORM_KINDS).toEqual([
    'http', 'https', 'socks5', 'ss', 'ss2022', 'trojan', 'vless-tcp', 'vless-ws', 'reality',
  ])
})

test('http / https 映射到同一个 kind，靠 tls 区分', () => {
  expect(defaultsFor('http', base)).toMatchObject({ kind: 'http', tls: false })
  expect(defaultsFor('https', base)).toMatchObject({ kind: 'http', tls: true })
  expect(formKindOf(defaultsFor('http', base))).toBe('http')
  expect(formKindOf(defaultsFor('https', base))).toBe('https')
})

test('formKindOf ∘ defaultsFor 对每个 FormKind 都是恒等', () => {
  for (const kind of FORM_KINDS) {
    expect(formKindOf(defaultsFor(kind, base))).toBe(kind)
  }
})

test('defaultsFor 保留 host / port / name', () => {
  for (const kind of FORM_KINDS) {
    expect(defaultsFor(kind, base)).toMatchObject(base)
  }
})

test('DEFAULT_PORTS 每个 FormKind 都有值', () => {
  for (const kind of FORM_KINDS) {
    expect(DEFAULT_PORTS[kind]).toBeGreaterThan(0)
  }
  expect(DEFAULT_PORTS.http).toBe(8080)
  expect(DEFAULT_PORTS.https).toBe(443)
  expect(DEFAULT_PORTS.socks5).toBe(1080)
  expect(DEFAULT_PORTS.ss).toBe(8388)
  expect(DEFAULT_PORTS.ss2022).toBe(8388)
})

test('draftUrl: url 为 null 时由结构化字段推导', () => {
  const url = draftUrl({
    name: 'node-1',
    config: defaultsFor('trojan', { host: 'h.example.com', port: 443, name: '' }),
    url: null,
    dialTimeoutSeconds: '',
  })
  expect(url.startsWith('trojan://')).toBe(true)
  expect(url).toContain('h.example.com:443')
  expect(url).toContain('#node-1')
})

test('draftUrl: url 非 null 时原样回显（用户正在编辑 URL）', () => {
  const raw = 'trojan://pw@other.example.com:8443'
  expect(draftUrl({
    name: 'node-1',
    config: defaultsFor('trojan', base),
    url: raw,
    dialTimeoutSeconds: '',
  })).toBe(raw)
})

test('draftUrl: host 为空时不推导，返回空串', () => {
  expect(draftUrl({
    name: 'node-1',
    config: defaultsFor('trojan', { host: '', port: 443, name: '' }),
    url: null,
    dialTimeoutSeconds: '',
  })).toBe('')
})

test('draftIssues: 名称为空时报 name', () => {
  const issues = draftIssues({
    name: '  ',
    config: defaultsFor('socks5', base),
    url: null,
    dialTimeoutSeconds: '',
  })
  expect(issues.name).toBe('dash.proxyErrName')
})

test('draftIssues: host 为空、port 越界时分别报到 config 上', () => {
  const issues = draftIssues({
    name: 'n',
    config: defaultsFor('socks5', { host: '', port: 0, name: '' }),
    url: null,
    dialTimeoutSeconds: '',
  })
  expect(issues.config.host).toBe('dash.proxyErrHost')
  expect(issues.config.port).toBe('dash.proxyErrPort')
})

test('draftIssues: 各协议的必填字段', () => {
  const empty = { host: 'h', port: 443, name: '' }
  const of = (kind: Parameters<typeof defaultsFor>[0]) =>
    draftIssues({ name: 'n', config: defaultsFor(kind, empty), url: null, dialTimeoutSeconds: '' }).config

  expect(of('http')).toEqual({})
  expect(of('socks5')).toEqual({})
  expect(of('ss').password).toBe('dash.proxyErrPassword')
  expect(of('ss2022').passwordBase64).toBe('dash.proxyErrPassword')
  expect(of('trojan').password).toBe('dash.proxyErrPassword')
  expect(of('vless-tcp').uuid).toBe('dash.proxyErrUuid')
  expect(of('vless-ws').uuid).toBe('dash.proxyErrUuid')
  expect(of('vless-ws').path).toBeUndefined()   // defaultsFor 给了 '/'
  expect(of('reality').publicKey).toBe('dash.proxyErrPublicKey')
  expect(of('reality').serverName).toBe('dash.proxyErrServerName')
})

test('parseProxyUriSafe: 解析失败返回 null 而不是抛错', () => {
  expect(parseProxyUriSafe('gopher://nope:1')).toBeNull()
  expect(parseProxyUriSafe('')).toBeNull()
  expect(parseProxyUriSafe('trojan://pw@h.example.com:443')).toMatchObject({
    kind: 'trojan', host: 'h.example.com', port: 443, password: 'pw',
  })
})

test('draftIssues: url 非 null 且无法解析时报 url', () => {
  const issues = draftIssues({
    name: 'n',
    config: defaultsFor('trojan', base),
    url: 'gopher://nope:1',
    dialTimeoutSeconds: '',
  })
  expect(issues.url).toBe('dash.proxyErrUrl')
})

test('draftIssues: dialTimeoutSeconds 非正整数时报错，留空则放行', () => {
  const of = (v: string) =>
    draftIssues({ name: 'n', config: defaultsFor('socks5', base), url: null, dialTimeoutSeconds: v })
  expect(of('').dialTimeout).toBeUndefined()
  expect(of('12').dialTimeout).toBeUndefined()
  expect(of('0').dialTimeout).toBe('dash.proxyErrDialTimeout')
  expect(of('-3').dialTimeout).toBe('dash.proxyErrDialTimeout')
  expect(of('abc').dialTimeout).toBe('dash.proxyErrDialTimeout')
  expect(of('1.5').dialTimeout).toBe('dash.proxyErrDialTimeout')
})
