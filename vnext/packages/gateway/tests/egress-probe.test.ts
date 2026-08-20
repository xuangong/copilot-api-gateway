/**
 * 出口探针的 IP 形状判定。
 *
 * 这两个谓词是连通性测试唯一的"真的通了"证据：trojan 服务端在密码错误时
 * 按设计返回一个假网站，TCP / TLS / 握手全部成功，只有"锚点回显的响应体
 * 是一个合法 IP"能把这种情况和真正连通区分开。判错方向都很贵——放过一个
 * HTML 片段会把坏密码报成 ok，误杀一个合法 IPv6 会把好节点报成坏。
 */
import { test, expect } from 'bun:test'
import {
  ANCHORS,
  isExpectedEgressIp,
  isIpV4,
  isIpV6,
} from '../src/control-plane/proxies/egress-probe.ts'

const V4_OK = ['1.2.3.4', '0.0.0.0', '255.255.255.255', '8.8.8.8']
const V4_BAD = [
  '',
  '1.2.3',
  '1.2.3.4.5',
  '256.1.1.1',
  '01.2.3.4',           // 前导零：不是规范写法，也是八进制歧义的来源
  '1.2.3.a',
  ' 1.2.3.4',
  '<html><body>hi',     // trojan 假网站的片段
]

for (const s of V4_OK) test(`isIpV4 接受 ${JSON.stringify(s)}`, () => expect(isIpV4(s)).toBe(true))
for (const s of V4_BAD) test(`isIpV4 拒绝 ${JSON.stringify(s)}`, () => expect(isIpV4(s)).toBe(false))

const V6_OK = [
  '::1',
  '::',
  '2001:db8:85a3:0:0:8a2e:370:7334',
  '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
  'fe80::1',
  '::ffff:1.2.3.4',      // v4-mapped：尾部的 v4 占两个 16 位组
  '2001:db8::1:0:0:1',
]
const V6_BAD = [
  '',
  '1.2.3.4',             // 纯 v4 不是 v6
  '2001:db8::1::2',      // 两个 ::
  ':::',
  '2001:db8:85a3:0:0:8a2e:370:7334:9999',   // 9 组
  '2001:db8:85a3:0:0:8a2e:370',             // 无 :: 且只有 7 组
  '2001:db8:85a3:0:0:8a2e:370:73345',       // 组超过 4 位十六进制
  'gggg::1',
  '::ffff:256.1.1.1',    // 尾部 v4 非法
  '<html>',
]

for (const s of V6_OK) test(`isIpV6 接受 ${JSON.stringify(s)}`, () => expect(isIpV6(s)).toBe(true))
for (const s of V6_BAD) test(`isIpV6 拒绝 ${JSON.stringify(s)}`, () => expect(isIpV6(s)).toBe(false))

test('ANCHORS 三个锚点齐备且都走 443', () => {
  expect(Object.keys(ANCHORS).sort()).toEqual(['aws', 'ident.me-v6', 'ipify'])
  for (const a of Object.values(ANCHORS)) {
    expect(a.port).toBe(443)
    expect(a.path.startsWith('/')).toBe(true)
    expect(a.host.length).toBeGreaterThan(0)
  }
})

/**
 * 出口 IP 判定。这是整个连通性测试的判据：trojan 服务端在密码错误时按设计
 * 返回一个假网站，TCP / TLS / 握手三段全部成功，只有"响应体不是 IP"能把
 * 认证失败和真正连通区分开。所以"响应体是 HTML"必须是一条独立用例。
 *
 * 这一层是唯一能钉住它的地方：走路由的话，请求到锚点要先完成一次真实的
 * userspace TLS 握手，字节脚本假冒不了，永远到不了这个分支。
 */
test.each([
  ['ipify', '203.0.113.7', true],
  ['ipify', '2001:db8::1', true],
  ['ipify', '<html><body>Welcome</body></html>', false],
  ['ipify', '', false],
  // v6 专用锚点回了 v4：流量根本没到那个锚点。
  ['ident.me-v6', '203.0.113.7', false],
  ['ident.me-v6', '2001:db8::1', true],
] as const)('isExpectedEgressIp(%s, %s) → %s', (anchor, text, expected) => {
  expect(isExpectedEgressIp(anchor, text)).toBe(expected)
})
