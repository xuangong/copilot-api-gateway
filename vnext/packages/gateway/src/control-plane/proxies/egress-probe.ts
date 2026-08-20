/**
 * 连通性测试的锚点表与 IP 形状判定。
 *
 * 纯数据 + 纯函数，不碰 Hono、不碰 repo，这样判定逻辑可以被表驱动测试
 * 单独钉住 —— 它是唯一能识破 "trojan 密码错误时返回假网站" 的那一步。
 */

/** 回显调用方出口 IP 的外部锚点。三个都是纯文本响应、都走 443。 */
export const ANCHORS = {
  'ipify': { host: 'api.ipify.org', port: 443, path: '/' },
  'aws': { host: 'checkip.amazonaws.com', port: 443, path: '/' },
  'ident.me-v6': { host: '6.ident.me', port: 443, path: '/' },
} as const

export type AnchorName = keyof typeof ANCHORS

/**
 * 点分四段 IPv4。刻意不接受前导零：`01.2.3.4` 在部分解析器里按八进制解读，
 * 是个经典的歧义来源，而合法锚点永远不会这么回显。
 */
export const isIpV4 = (s: string): boolean => {
  const parts = s.split('.')
  if (parts.length !== 4) return false
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false
    if (p.length > 1 && p.startsWith('0')) return false
    if (Number(p) > 255) return false
  }
  return true
}

/**
 * RFC 4291 文本形态的 IPv6，含 `::` 压缩与内嵌 v4 尾巴。按组计数判定：
 * 没有 `::` 时必须正好 8 组，有 `::` 时至多 7 组（`::` 至少代表一组零）。
 * 内嵌的 v4 尾巴（`::ffff:1.2.3.4`）占最后两个 16 位组。
 */
export const isIpV6 = (s: string): boolean => {
  if (s.includes(':::')) return false
  if (s.split('::').length - 1 > 1) return false

  const lastColon = s.lastIndexOf(':')
  if (lastColon < 0) return false          // 没有冒号：不可能是 IPv6

  let body = s
  let tailGroups = 0
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    if (!isIpV4(tail)) return false
    body = s.slice(0, lastColon)
    tailGroups = 2                          // v4 尾巴等价于两个 16 位组
  }

  const compressed = body.includes('::')
  const [left, right] = compressed ? body.split('::') : [body, undefined]
  const split = (part: string | undefined): string[] =>
    part === undefined || part === '' ? [] : part.split(':')
  const groups = [...split(left), ...split(right)]
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false
  }

  const total = groups.length + tailGroups
  return compressed ? total <= 7 : total === 8
}

/**
 * 锚点回显的正文是否是一个可接受的出口 IP。v6 专用锚点必须回 v6 —— 回了
 * v4 说明流量根本没到那个锚点。
 *
 * 这条判定单独成函数，是因为路由自身走到这一步要先完成一次到锚点的真实
 * userspace TLS 握手，用字节脚本假冒不了，只能在这一层直接钉住。
 */
export const isExpectedEgressIp = (anchor: AnchorName, text: string): boolean =>
  anchor === 'ident.me-v6' ? isIpV6(text) : isIpV4(text) || isIpV6(text)
