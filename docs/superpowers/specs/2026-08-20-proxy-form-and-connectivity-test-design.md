# Proxies Tab: 全协议结构化表单 + 连通性测试 设计

> 分支：`vNext`。所有改动留在 `vNext`，未经明确确认不合入 `main`。

## 背景

Dashboard 的 Proxies tab 目前只有一个裸 URL 输入框（`apps/dashboard/src/tabs/proxies/ProxiesTab.tsx`），
运营者必须手写 `trojan://password@host:443?sni=...#name` 这类字符串。而
`packages/proxy` 实际已经实现了 8 种代理协议（dashboard 侧拆成 9 个表单类型，
因为 http 明文和 https-over-TLS 共用 `kind: 'http'` 但 scheme 不同）：

| FormKind | ProxyConfig | URI scheme | 默认端口 |
| --- | --- | --- | --- |
| `http` | `{kind:'http', tls:false}` | `http://` | 8080 |
| `https` | `{kind:'http', tls:true}` | `https://` | 443 |
| `socks5` | `{kind:'socks5'}` | `socks5://` | 1080 |
| `ss` | `{kind:'ss'}` | `ss://` | 8388 |
| `ss2022` | `{kind:'ss2022'}` | `ss://` | 8388 |
| `trojan` | `{kind:'trojan'}` | `trojan://` | 443 |
| `vless-tcp` | `{kind:'vless-tcp'}` | `vless://?type=tcp&security=tls` | 443 |
| `vless-ws` | `{kind:'vless-ws'}` | `vless://?type=ws&security=tls` | 443 |
| `reality` | `{kind:'reality'}` | `vless://?type=tcp&security=reality` | 443 |

同时没有任何「保存前先验证这个节点能用」的手段：配置错误只有在真实请求
打到上游、失败、走 backoff 之后才暴露。

调研阶段发现四个问题，本设计全部覆盖：

1. 表单只支持裸 URL，无按协议的结构化字段。
2. 没有连通性测试。
3. **`ss://` base64url 解析 bug（已实测复现）** — `url.ts` 用 `atob()` 直解
   userinfo，遇到 base64url 字母表（`-`/`_`）直接抛错，而 base64url 是
   SIP002 之外主流客户端普遍产出的形式。
4. `reality.ts` 里有一份手写的 base64url 垫片，与 `bytes.ts` 的 base64
   实现平行存在。

---

## §1 层次与职责边界

```
apps/dashboard/src/tabs/proxies/
  ProxiesTab.tsx        改：列表行加「测试」按钮 + 结果显示
  ProxyForm.tsx         新：URL ⇄ 结构化 双向同步表单
  proxy-form-config.ts  新：FormKind 联合、默认端口表、字段校验（纯函数，不依赖 React）
    ↓ import
packages/proxy/src/url.ts        parseProxyUri / formatProxyUri（协议知识唯一事实来源）
packages/proxy/src/bytes.ts      新增 base64UrlDecodeBytes / base64UrlEncodeBytes
    ↑ 同时被
packages/proxy/src/protocols/reality.ts       删掉私有 shim
packages/proxy/src/protocols/shadowsocks-2022.ts  PSK 解码放宽

packages/gateway/src/control-plane/proxies/
  egress-probe.ts       新：锚点表 + isIpV4 / isIpV6（纯函数）
  routes.ts             改：加 POST /api/proxies/test
```

四条边界：

1. **`url.ts` 是协议知识的唯一来源。** dashboard 不重新实现解析/格式化。
   现有已有三张必须同步的分派表（`url.ts:80` 按 scheme 解析、`url.ts:306`
   按 kind 格式化、`dialer.ts:80` 按 kind 拨号）；在前端再写一份会变成五张。
2. **`bytes.ts` 是 base64 的唯一实现。** `reality.ts` 的私有垫片删除。
3. **`egress-probe.ts` 与 `routes.ts` 分离**，让 IP 形状判定这类纯函数不必
   经过 HTTP 就能测。
4. **只有一个 `POST /api/proxies/test`**，admin 门禁，表单和列表行共用。

### 为什么解析放在浏览器端

`packages/proxy/src/url.ts` 只 import `./errors.ts` 和 `./proxy-config.ts`
的类型，**零运行时依赖、浏览器安全**，可以直接进 dashboard bundle。
`packages/proxy/package.json` 的 exports 已有 `"./url"` 子路径。

排除的方案：

- **服务端 `POST /api/proxies/parse`** — 每次按键一个往返，且把明文密码
  多送一次上网。
- **在 dashboard 重写解析/格式化** — 分派表从 3 张涨到 5 张。

需要在 `apps/dashboard/package.json` 加 `"@vibe-core/proxy": "workspace:*"`。

---

## §2 双向同步机制

表单形态：顶部 URL 输入框，下面协议下拉 + 按协议字段，两侧互相同步。

```
名称        [                    ]
URL         [                    ]
────────────────────────────────────
协议        [ trojan          ▾ ]
地址        [          ] 端口 [    ]
密码        [                    ]
SNI         [                    ]
拨号超时    [        ] 秒
────────────────────────────────────
[测试连通性]              [取消] [保存]
```

草稿状态：

```ts
type ProxyDraft = {
  name: string
  config: ProxyConfig
  url: string | null
  dialTimeoutSeconds: string
}

const draftUrl = (d: ProxyDraft): string =>
  d.url ?? (d.config.host.trim()
    ? formatProxyUri({ ...d.config, name: d.name.trim() })
    : "")
```

`url: string | null` 是真相开关：

- `url === null` → URL 框是 `config` 的投影，由 `formatProxyUri` 实时生成。
- `url !== null` → 运营者手输的文本就是真相，原样显示。

三条转换规则：

- **编辑 URL** → `setUrl(value)`；`parseProxyUri` 成功时才写回 `config`，
  **失败时保留原 config 不动**。这一条是半输入状态不闪烁的全部诀窍：
  粘贴到一半的 URL 不会把已填好的结构化字段清空。
- **编辑任一结构化字段** → 改 `config`，同时 `url = null`，真相翻回结构化侧。
- **切换协议下拉** → `defaultsFor(nextKind, { host, port, name })`，
  保留地址/端口/名称，其余字段按新协议重置。

不做防抖：`parseProxyUri` 是纯函数、零 I/O。

### 校验时机

- **URL 解析错误**：立即显示（文本是运营者已经打完的）。
- **必填字段缺失**：第一次按「保存」之后才显示，此后跟随每次编辑。

各协议必填字段：

| FormKind | 必填 |
| --- | --- |
| `http` / `https` / `socks5` | host, port |
| `ss` | + password（method 有默认值） |
| `ss2022` | + passwordBase64 |
| `trojan` | + password |
| `vless-tcp` | + uuid |
| `vless-ws` | + uuid, path |
| `reality` | + uuid, serverName, publicKey |

「测试」的门槛比「保存」低：只要 url / dialTimeout / host / port 无问题即可，
名称可以为空——测试只拨号，不落库。

---

## §3 后端：连通性测试

### §3.1 为什么是「回显出口 IP」而不是「连上了没有」

用户的要求是「除了网络连通与否还要看认证对不对」。逐协议看认证失败落在哪个阶段：

| 协议 | 密码错误时 |
| --- | --- |
| http / https | 407 → `proxy-handshake` |
| socks5 | 认证子协商拒绝 → `proxy-handshake` |
| ss / ss2022 | AEAD 解密失败 / `SS2022: salt-echo mismatch` → `proxy-handshake` |
| vless-tcp / vless-ws | `VLESS reply: EOF before prefix` |
| reality | `REALITY: server HMAC-SHA512 over leaf pubkey did not match` |
| **trojan** | **无错误——服务端按设计返回伪装网站** |

trojan 密码错时 TCP、外层 TLS、握手全部成功，服务端静默把流量转给一个假网站。
**只有校验响应体是不是一个形状合法的 IP 才能抓住它。** 这就是设计选「回显出口 IP」
而不是「握手成功即通过」的原因，也是整个功能的验收核心。

### §3.2 锚点

```ts
export const ANCHORS = {
  'ipify':       { host: 'api.ipify.org',      port: 443, path: '/' },
  'aws':         { host: 'checkip.amazonaws.com', port: 443, path: '/' },
  'ident.me-v6': { host: '6.ident.me',         port: 443, path: '/' },
} as const
```

UI 上是一个紧凑下拉，默认 `ipify`。三个而不是一个：单点锚点挂掉时无法区分
「锚点挂了」和「代理坏了」；`6.ident.me` 强制走 IPv6，用来验证 v6 出口。

**CFW 与 Bun 无需分别处理**：runtime 的 `connect()` 只开到**代理服务器**的
socket，锚点是在隧道内部由代理服务器自己去访问的。所以 CFW 的 connect 限制、
以及「api.ipify.org 在 Cloudflare 后面」都不构成问题。

### §3.3 路由

```ts
const testBody = z.object({
  url: z.string().min(1),
  dialTimeoutSeconds: z.number().int().positive().nullish(),
  anchor: z.enum(['ipify', 'aws', 'ident.me-v6']).optional(),  // 默认 ipify
})
```

（沿用 `proxies/routes.ts` 现有的 camelCase 请求体风格，与 `createBody` 一致。）

挂在 `proxiesRouter` 下，自动继承其 `use('*')` admin 门禁。

三条返回通道，**必须区分**：

| 情况 | 返回 |
| --- | --- |
| URL 解析失败 | `400 { error }` — 这是表单校验，不是代理故障 |
| `ProxyDialError` | `200 { ok: false, error: "[stage] message" }` |
| 响应体不是合法 IP | `200 { ok: false, error: ... }` — trojan 伪装页 |
| 成功 | `200 { ok: true, egressIp }` |

实现要点：

- `runProxiedRequest(config, { host, port, tls: true }, { method: 'GET',
  path, headers: { 'User-Agent': 'vibe-proxy-test/1' } },
  { socketDial: getSocketDial(), ...dialTimeoutMs })`
- 响应体 `.slice(0, 256).trim()` 后做 IP 形状判定。
- v6 锚点返回 v4 → `ok: false`（说明没走到 v6 出口）。
- **只 catch `ProxyDialError`，其余异常一律重抛。** 否则一个 `TypeError`
  会伪装成「代理不通」，把程序 bug 报成运维问题。
- 测试不支持 direct / 无代理。

### §3.4 base64url 统一 + UTF-8 修正

`bytes.ts` 新增两个 helper，不引入新依赖：

```ts
export const base64UrlDecodeBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  return base64DecodeBytes(std.padEnd(std.length + ((4 - (std.length % 4)) % 4), '='))
}

export const base64UrlEncodeBytes = (bytes: Uint8Array): string =>
  base64EncodeBytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
```

解码端一个函数吃下全部四种组合（{标准, url 字母表} × {有补位, 无补位}）：
`-`/`_` 替换对标准输入是空操作，对已补齐的串再补位也是空操作。

排除 `@scure/base`：为一段已经写了一半的逻辑往 dashboard bundle 里塞一个包。

三个消费方：

1. `reality.ts:416` — 删私有 shim，纯重构。
2. `url.ts:192` ss 解析 — **本次确认的 bug 修复**。
3. `shadowsocks-2022.ts:49` PSK — 纯放宽。

**同时修正 UTF-8 语义**（用户已确认要做）：ss 解析改为
`base64UrlDecodeBytes` + `TextDecoder('utf-8')`；ss 格式化改为
`utf8Bytes()` + `base64UrlEncodeBytes`。修掉两个真实互操作 bug：

- 现在 `btoa` 输出 Latin-1 字节，`ä` 上线是 `0xE4` 而真实 SS 客户端期待
  `0xC3 0xA4` —— 线上不兼容。
- `btoa` 遇到中文密码**直接抛异常**，这类节点现在根本存不进来。

`url.ts:16` 承诺的 round-trip 保证（`parseProxyUri(formatProxyUri(c))`
深等于 `c`）继续成立。

已接受的风险：若库里已存在非 ASCII 密码的 `ss://` 行，解出来会变乱码。
实际上不可能存在——这种 URL 现在就存不进去（`btoa` 会抛）。

---

## §4 测试策略

### 已有覆盖的真实缺口

`url_test.ts` 中全部 3 条 `ss://` 用例都用标准字母表 base64。
**base64url 路径一行测试都没有**，这正是 bug 活到今天的原因。

两个既有用例必须一并处理：

1. **`url_test.ts:214` 的 `'ss://invalid-base64@h:443'`** — 放宽字母表后，
   `invalid-base64` → `invalid+base64`（14 字符，补到 16）是**合法 base64**，
   解得开，随后在「解出来没有 `:`」分支抛错。断言是 `toThrow(ProxyUriError)`
   不带消息正则，所以测试**不会红**，但它名不副实了。
   改成真正非法的输入（如 `ss://!!!@h:443`），另补一条无冒号用例。
   「测试还绿着但已经不测它声称的东西」比测试变红更危险。
2. **`url_test.ts:239` 的 round-trip 表** — 格式化端改 base64url-nopad 后，
   输出串从 `YWVzLTEyOC1nY206YWJjZA==` 变成 `YWVzLTEyOC1nY206YWJjZA`。
   断言比的是对象不是字符串，照样通过。这正是那条 round-trip 保证的价值。

### 新增测试

**`packages/proxy/src/__tests__/url_test.ts`**

- `ss://` base64url 字母表（含 `-` 和 `_`）解析成功 — **回归锚**，就是本次实测失败的串
- `ss://` 有补位 / 无补位 都能解
- UTF-8 密码（中文）round-trip — 以前 `btoa` 直接抛，现在必须存得进解得出
- 非 ASCII 密码解出的字节是 UTF-8 而非 Latin-1（断言具体码点，否则测不出区别）
- 替换后的真·非法 base64 用例 + 无冒号用例

**`packages/proxy/src/__tests__/bytes_test.ts`（新建）**

- `base64UrlDecodeBytes` 四种组合全通
- `base64UrlEncodeBytes` 输出不含 `+` `/` `=`
- 两者互逆

**`packages/gateway/tests/control-plane-proxies.test.ts`（追加）**

- 非 admin → 403
- URL parse 失败 → **400**（不是 `ok:false`）
- `ProxyDialError` → `200 {ok:false, error:"[stage] …"}`，断言 stage 前缀存在
- **非 `ProxyDialError` 必须重抛** — 防止程序 bug 伪装成「代理不通」
- 锚点回非 IP 正文 → `ok:false`（**模拟 trojan 密码错的伪装页**）
- v6 锚点回了 v4 → `ok:false`
- 成功 → `{ok:true, egressIp}`

用已存在的 `packages/proxy/src/fake-socket-dial.ts` 注入假 socket，不打真网络。

**`egress-probe.ts` 的 `isIpV4` / `isIpV6`** — 表驱动纯函数测试，必须含：
`999.999.999.999` 拒、`aaaa::bbbb::cccc`（两个 `::`）拒、前导零 `01.2.3.4` 拒、
内嵌 v4 尾 `::ffff:1.2.3.4` 收。

### Dashboard 侧

`apps/dashboard` 目前没有任何测试文件，本设计不为此功能单独搭前端测试基建。
但有一条现成护栏必须满足：

**`packages/gateway/tests/i18n-keys.test.ts`** 会扫描 dashboard 源码里所有
`t("...")` 字面量，逐个校验 `en` 和 `zh` 字典都有。新表单的每个标签
（协议名、字段名、校验消息、测试结果文案）**都必须同步加进
`packages/gateway/src/shared/edge/ui-pages/i18n.ts` 的 `renderI18nScript()`
两本字典**，否则这条测试直接红。这是漏加文案的唯一自动防线。

纯函数部分（`draftUrl`、`draftIssues`、`defaultsFor`）放在
`proxy-form-config.ts`、不依赖 React，将来可随时补测试。

### 手工验证（本地 Docker）

用真实 trojan 节点：

1. 表单粘 URL → 下面字段自动填好；改端口 → URL 跟着变
2. 点测试 → 出口 IP 应为 homelab 出口，**不是**本机 IP
3. 故意改错 trojan 密码 → 应报「锚点返回的不是 IP」，而不是「成功」

第 3 条是整个设计的验收核心。

---

## 不做的事（YAGNI）

- 不为 dashboard 搭前端测试基建
- 测试不支持 direct / 无代理路径
- 不做「保存时自动测试」——测试是显式动作
- 不做批量测试全部节点
- 不引入 `@scure/base` / `ipaddr.js`
