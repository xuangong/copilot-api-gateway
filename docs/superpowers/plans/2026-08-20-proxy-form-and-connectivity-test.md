# Proxy 结构化表单与连通性测试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 vNext Dashboard 的 Proxies tab 能以结构化表单增删改全部 9 种代理形态（http / https / socks5 / ss / ss2022 / trojan / vless-tcp / vless-ws / reality），并为每个节点提供一个"回显出口 IP"的连通性测试；同时修掉 `ss://` 的 base64url 解析不兼容，并把 REALITY 里手写的 base64url shim 收敛到共享 helper。

**Architecture:** 三层，边界清晰。
`packages/proxy` 保持框架无关，只负责 URI ⇄ `ProxyConfig` 的解析/格式化与拨号；本次在 `bytes.ts` 增加 `base64UrlDecodeBytes` / `base64UrlEncodeBytes` 两个共享 helper，`url.ts` 的 `ss://` 分支改用它们。
`packages/gateway` 新增一个纯函数模块 `control-plane/proxies/egress-probe.ts`（锚点表 + IP 形状判定），以及 `POST /api/proxies/test` 路由——它通过 `runProxiedRequest` 走真实隧道向外部锚点发 GET，把响应体当作出口 IP 回显；只有响应体是一个合法 IP 才算通过，这样才能识破 trojan 的"错密码返回假网站"行为。
`apps/dashboard` 新增 `proxy-form-config.ts`（纯数据/纯函数：FormKind 枚举、默认值、默认端口、`draftUrl`、`draftIssues`）和 `ProxyForm.tsx`（受控 UI），由 `ProxiesTab.tsx` 组装。URL 输入框与结构化字段双向同步，靠 `url: string | null` 这个 sentinel 决定"当前以哪边为准"。

**Tech Stack:** Bun 1.3 + `bun test`、TypeScript、Hono + zod（control-plane）、React + Tailwind（dashboard）、`@vibe-core/proxy` workspace 包。

---

## File Structure

**`vnext/packages/proxy/`**（框架无关，禁止引入 Hono / React）
- `src/bytes.ts` — 修改：新增 `base64UrlDecodeBytes` / `base64UrlEncodeBytes`
- `src/__tests__/bytes_test.ts` — 新建：两个 helper 的单测
- `src/protocols/reality.ts:416-417` — 修改：删掉私有 `base64UrlDecode`，改用共享 helper
- `src/protocols/shadowsocks-2022.ts:49` — 修改：PSK 解码放宽到 base64url
- `src/url.ts` — 修改：`parseSs` / `formatSs` 改用 base64url + UTF-8
- `src/__tests__/url_test.ts` — 修改：修两条受影响的用例，补 base64url 与 CJK 往返用例

**`vnext/packages/gateway/`**
- `src/control-plane/proxies/egress-probe.ts` — 新建：`ANCHORS`、`AnchorName`、`isIpV4`、`isIpV6`
- `src/control-plane/proxies/routes.ts` — 修改：新增 `POST /test`
- `tests/egress-probe.test.ts` — 新建：IP 形状判定表驱动测试
- `tests/control-plane-proxies.test.ts` — 修改：新增 `/test` 路由用例

**`vnext/apps/dashboard/`**
- `package.json` — 修改：加 `@vibe-core/proxy` 依赖
- `src/tabs/proxies/proxy-form-config.ts` — 新建：纯逻辑（FormKind、默认值、默认端口、`draftUrl`、`draftIssues`）
- `src/tabs/proxies/ProxyForm.tsx` — 新建：受控表单 UI
- `src/tabs/proxies/ProxiesTab.tsx` — 修改：接入表单 + 每行测试按钮
- `src/api/proxies.ts` — 修改：新增 `testProxy()`

**`vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts`** — 修改：EN / ZH 两份字典同步新增 key

**任务顺序依赖：** T1 → T2、T3（都依赖 helper）；T4 → T5；T6 → T7 → T8。T1-T3、T4-T5、T6-T8 三组之间互不依赖。

---

### Task 1: base64url 共享 helper

**Files:**
- Modify: `vnext/packages/proxy/src/bytes.ts`（在 `base64DecodeBytes` 之后追加）
- Test: `vnext/packages/proxy/src/__tests__/bytes_test.ts`（新建）

背景：`packages/proxy` 里现在有两处各自手写 base64url 转换（`protocols/reality.ts:416`），并且 `url.ts` 的 `ss://` 解析只用了标准 `atob`，遇到 base64url 变体（含 `-` / `_`、无 `=` 填充）会抛错。先把 helper 建出来，后两个任务再去消费它。

现有 `bytes.ts` 里已有的两个函数（不要改动，helper 直接复用）：

```ts
export const base64EncodeBytes = (bytes: Uint8Array): string => { /* fromCharCode 循环 → btoa */ }
export const base64DecodeBytes = (s: string): Uint8Array<ArrayBuffer> => { /* atob → charCodeAt 循环 */ }
```

- [ ] **Step 1: 写失败的测试**

新建 `vnext/packages/proxy/src/__tests__/bytes_test.ts`：

```ts
/**
 * base64url helper 单测。
 *
 * 这两个 helper 是 `ss://` URI 解析和 REALITY 的 `pbk` 参数共用的转换层：
 * 两处都要接受标准 base64 和 base64url 两种拼写，且 base64url 侧的 `=`
 * 填充是可选的。用例按"解码宽松、编码严格"来钉：解码同时吃两种字母表，
 * 编码只产出无填充的 base64url。
 */
import { test, expect } from 'bun:test';
import { base64UrlDecodeBytes, base64UrlEncodeBytes, utf8Bytes } from '../bytes.ts';

const decodeToText = (s: string): string =>
  new TextDecoder().decode(base64UrlDecodeBytes(s));

test('base64UrlDecodeBytes 接受标准 base64（含 = 填充）', () => {
  expect(decodeToText('YWVzLTEyOC1nY206YWJjZA==')).toBe('aes-128-gcm:abcd');
});

test('base64UrlDecodeBytes 接受省略了 = 填充的输入', () => {
  expect(decodeToText('YWVzLTEyOC1nY206YWJjZA')).toBe('aes-128-gcm:abcd');
});

test('base64UrlDecodeBytes 把 - 和 _ 映射回 + 和 /', () => {
  // 0xfb 0xff 0xbe → 标准 base64 "+/++"，base64url 写作 "-_--"。
  expect(Array.from(base64UrlDecodeBytes('-_--'))).toEqual([0xfb, 0xff, 0xbe]);
  expect(Array.from(base64UrlDecodeBytes('+/++'))).toEqual([0xfb, 0xff, 0xbe]);
});

test('base64UrlDecodeBytes 对非法字母表输入抛错', () => {
  expect(() => base64UrlDecodeBytes('!!!')).toThrow();
});

test('base64UrlEncodeBytes 产出无填充的 base64url', () => {
  expect(base64UrlEncodeBytes(new Uint8Array([0xfb, 0xff, 0xbe]))).toBe('-_--');
  // 3 字节整除，无填充；4 字节会补两个 =，必须被剥掉。
  expect(base64UrlEncodeBytes(new Uint8Array([0xfb, 0xff, 0xbe, 0x01]))).toBe('-_--AQ');
});

test('编码 / 解码对多字节 UTF-8 往返', () => {
  const text = '密码:测试-passwörd';
  const round = decodeToText(base64UrlEncodeBytes(utf8Bytes(text)));
  expect(round).toBe(text);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/proxy/src/__tests__/bytes_test.ts
```

预期：失败，报 `base64UrlDecodeBytes` / `base64UrlEncodeBytes 不是导出`（`SyntaxError: export 'base64UrlDecodeBytes' not found`）。

- [ ] **Step 3: 实现 helper**

在 `vnext/packages/proxy/src/bytes.ts` 中，紧跟在 `base64DecodeBytes` 函数体之后追加：

```ts
/**
 * 解码 base64url。为兼容野生 URI，字母表和填充都放宽：`-`/`_` 会被映射回
 * `+`/`/`，缺失的 `=` 会补齐，因此标准 base64 也能原样吃下。非法字符仍由
 * 底层 `atob` 抛错。
 */
export const base64UrlDecodeBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  return base64DecodeBytes(std.padEnd(std.length + ((4 - (std.length % 4)) % 4), '='));
};

/**
 * 编码为无填充的 base64url —— 这是写进 URI 的规范形态，`=` 在 query/userinfo
 * 位置需要百分号转义，去掉它可以让往返后的字符串保持稳定。
 */
export const base64UrlEncodeBytes = (bytes: Uint8Array): string =>
  base64EncodeBytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/proxy/src/__tests__/bytes_test.ts
```

预期：6 pass, 0 fail。

- [ ] **Step 5: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && git add packages/proxy/src/bytes.ts packages/proxy/src/__tests__/bytes_test.ts && git commit -m "feat(proxy): add shared base64url encode/decode helpers"
```

---

### Task 2: 收敛 REALITY 私有 shim，放宽 ss2022 PSK 解码

**Files:**
- Modify: `vnext/packages/proxy/src/protocols/reality.ts:416-417`
- Modify: `vnext/packages/proxy/src/protocols/shadowsocks-2022.ts:16,49`

背景：Task 1 建好的 helper 现在有两个消费方。REALITY 里有一份逐字相同的私有实现，删掉即可；ss2022 的 PSK 解码目前用严格的 `base64DecodeBytes`，同样应该接受 base64url——SIP022 的密钥经常以 base64url 形态出现在订阅链接里。

- [ ] **Step 1: 删掉 REALITY 私有 shim**

在 `vnext/packages/proxy/src/protocols/reality.ts` 中删除这两行（约 416-417 行）：

```ts
const base64UrlDecode = (s: string): Uint8Array<ArrayBuffer> =>
  base64DecodeBytes(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '='));
```

然后把文件内所有 `base64UrlDecode(` 的调用点改为 `base64UrlDecodeBytes(`。用下面这条命令找出全部调用点，逐个改：

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && grep -n "base64UrlDecode" packages/proxy/src/protocols/reality.ts
```

最后修 import：把 `reality.ts` 顶部从 `'../bytes.ts'` 的 import 里加上 `base64UrlDecodeBytes`。如果删除 shim 后 `base64DecodeBytes` 在该文件中已无其他调用点，就把它从 import 列表里移除（用上面同样的 `grep -n "base64DecodeBytes"` 确认）。

- [ ] **Step 2: 放宽 ss2022 PSK 解码**

在 `vnext/packages/proxy/src/protocols/shadowsocks-2022.ts`：

第 16 行的 import 改为（把 `base64DecodeBytes` 换成 `base64UrlDecodeBytes`；若 `base64DecodeBytes` 在本文件其他地方仍被调用则两个都留着）：

```ts
import { base64UrlDecodeBytes, concat, encodeAtypAddress, randomBytes, utf8Bytes } from '../bytes.ts';
```

第 49 行改为：

```ts
    psk = base64UrlDecodeBytes(config.passwordBase64);
```

第 51 行的报错文案保持不变（`'SS2022: invalid base64 in PSK'`）——base64url 是 base64 的一种拼写，这句话依然为真。

- [ ] **Step 3: 跑 proxy 包全量测试**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/proxy
```

预期：全绿。行为没有收窄，只有放宽，既有用例不应受影响。

- [ ] **Step 4: typecheck**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run --filter '@vibe-core/proxy' typecheck
```

预期：无输出、退出码 0。若报 `base64DecodeBytes` 已声明但未使用，说明 Step 1/2 的 import 清理漏了，回去补。

- [ ] **Step 5: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && git add packages/proxy/src/protocols/reality.ts packages/proxy/src/protocols/shadowsocks-2022.ts && git commit -m "refactor(proxy): use shared base64url helper in reality and ss2022"
```

---

### Task 3: `ss://` 改用 base64url + UTF-8

**Files:**
- Modify: `vnext/packages/proxy/src/url.ts`（`parseSs` 约 162-210 行、`formatSs` 约 375-385 行）
- Test: `vnext/packages/proxy/src/__tests__/url_test.ts`

背景：这是本次要修的实证 bug。legacy `ss://` 的 userinfo 是 `base64(method:password)`，野生链接里普遍是 **base64url 无填充**形态，而当前实现直接调 `atob`，遇到 `-` / `_` 或缺失填充就抛 `ProxyUriError`。

同时做一个语义变更（spec §3.4 已获批准）：编码/解码从 Latin-1 改为 **UTF-8**。原来的 `btoa` 只能吃 Latin-1，密码里出现任何非 Latin-1 字符（例如中文）都会直接抛 `InvalidCharacterError`；改成 UTF-8 后这类密码能正确往返。代价是：如果某个存量密码含 U+0080–U+00FF 区间的字符（如 `ö`），它的编码结果会从 1 字节变成 2 字节，即同一个密码的 URI 文本表示发生变化。这是有意为之——Latin-1 路径本来就无法表达大多数密码，UTF-8 与主流客户端一致。

现有 `parseSs` 中要改的两处（第一处是 bug 本体，第二处是 UTF-8 语义）：

```ts
  let decoded: string;
  try { decoded = atob(username); }
  catch (cause) { throw new ProxyUriError('malformed ss userinfo (invalid base64)', { cause }); }
```

现有 `formatSs` 全文：

```ts
const formatSs = (config: ShadowsocksProxyConfig): string => {
  // Legacy SS userinfo is the entire base64-encoded `method:password`;
  // `btoa` handles only Latin-1 input, which matches every byte SS allows
  // in either field.
  const userinfo = btoa(`${config.method}:${config.password}`);
  return `ss://${userinfo}@${config.host}:${config.port}${
    formatFragment(config.name, config.host, config.port)}`;
};
```

- [ ] **Step 1: 写失败的测试**

在 `vnext/packages/proxy/src/__tests__/url_test.ts` 末尾追加（`parseProxyUri` / `formatProxyUri` / `ProxyUriError` 已在文件顶部 import，无需重复）：

```ts
test('ss:// 接受 base64url 无填充的 userinfo', () => {
  // 标准 base64 是 "YWVzLTEyOC1nY206YWJjZA=="；野生链接常写成无填充形态。
  const config = parseProxyUri('ss://YWVzLTEyOC1nY206YWJjZA@1.2.3.4:8388#tag');
  expect(config).toEqual({
    kind: 'ss',
    method: 'aes-128-gcm',
    password: 'abcd',
    host: '1.2.3.4',
    port: 8388,
    name: 'tag',
  });
});

test('ss:// 接受 base64url 字母表（- 与 _）', () => {
  // "aes-256-gcm:a?b>c" 的标准 base64 含 '+' 与 '/'，base64url 写作 '-' 与 '_'。
  const std = btoa('aes-256-gcm:a?b>c');
  const urlSafe = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const config = parseProxyUri(`ss://${urlSafe}@1.2.3.4:8388#tag`);
  expect(config).toMatchObject({ kind: 'ss', method: 'aes-256-gcm', password: 'a?b>c' });
});

test('ss:// 密码可含多字节 UTF-8 并往返', () => {
  const config = {
    kind: 'ss',
    method: 'aes-256-gcm',
    password: '密码pässwörd',
    host: '1.2.3.4',
    port: 8388,
    name: 'tag',
  } as const;
  expect(parseProxyUri(formatProxyUri(config))).toEqual(config);
});

test('ss:// userinfo 解出来没有冒号时抛 ProxyUriError', () => {
  // "no-colon-here" 的 base64，解码成功但不含分隔符。
  const userinfo = btoa('no-colon-here');
  expect(() => parseProxyUri(`ss://${userinfo}@h:8388`)).toThrow(ProxyUriError);
});
```

- [ ] **Step 2: 修两条会被语义变更影响的既有用例**

在 `vnext/packages/proxy/src/__tests__/url_test.ts` 的 throw-list（约 208-231 行）中，把这一行：

```ts
    'ss://invalid-base64@h:443',
```

替换为：

```ts
    'ss://!!!@h:443',
```

原因：放宽到 base64url 之后，`invalid-base64` 里的 `-` 会被映射成 `+`，长度 14 补齐到 16，`atob` 解码成功，于是它不再是"非法 base64"用例——虽然后续 `indexOf(':') < 0` 仍会抛同一个错误类型，断言依旧是绿的，但这条用例已经不再测它声称要测的东西。`!!!` 不在任何 base64 字母表里，才是真正的非法输入。（"解码成功但没有冒号"这条路径由 Step 1 新增的用例单独覆盖。）

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/proxy/src/__tests__/url_test.ts
```

预期：至少 3 条失败——base64url 无填充与 `-`/`_` 两条报 `ProxyUriError: malformed ss userinfo (invalid base64)`，UTF-8 往返那条报 `InvalidCharacterError`（来自 `btoa`）。

- [ ] **Step 4: 实现**

在 `vnext/packages/proxy/src/url.ts` 顶部，把 `base64UrlDecodeBytes` 和 `base64UrlEncodeBytes` 加入从 `'./bytes.ts'` 的 import（若该文件目前没有从 `bytes.ts` 的 import，则新增一行 `import { base64UrlDecodeBytes, base64UrlEncodeBytes, utf8Bytes } from './bytes.ts';`；若已有则合并进去，并确认 `utf8Bytes` 在列）。

`parseSs` 中的解码块改为：

```ts
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(base64UrlDecodeBytes(username));
  } catch (cause) {
    throw new ProxyUriError('malformed ss userinfo (invalid base64)', { cause });
  }
```

`formatSs` 全文替换为：

```ts
const formatSs = (config: ShadowsocksProxyConfig): string => {
  // Legacy SS userinfo is the entire base64-encoded `method:password`. We emit
  // unpadded base64url over UTF-8 bytes: `=` would need percent-escaping in
  // userinfo position, and UTF-8 (rather than `btoa`'s Latin-1) is what every
  // mainstream client uses, so non-Latin-1 passwords survive the round trip.
  const userinfo = base64UrlEncodeBytes(utf8Bytes(`${config.method}:${config.password}`));
  return `ss://${userinfo}@${config.host}:${config.port}${
    formatFragment(config.name, config.host, config.port)}`;
};
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/proxy
```

预期：全绿。注意既有的往返用例 `'ss://YWVzLTI1Ni1nY206c2VjcmV0@1.2.3.4:8388#tag'` 断言的是 `parseProxyUri(formatProxyUri(config))`（config 往返，不是字符串往返），ASCII 密码在新旧编码下字节一致，因此不受影响；而 `'ss://YWVzLTEyOC1nY206YWJjZA==@h:8388#p'` 同理仍然可解析。

- [ ] **Step 6: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && git add packages/proxy/src/url.ts packages/proxy/src/__tests__/url_test.ts && git commit -m "fix(proxy): accept base64url ss:// userinfo and encode over UTF-8"
```

---

### Task 4: 出口探针的纯逻辑模块

**Files:**
- Create: `vnext/packages/gateway/src/control-plane/proxies/egress-probe.ts`
- Test: `vnext/packages/gateway/tests/egress-probe.test.ts`（新建）

背景：连通性测试的判定核心是"响应体是不是一个合法 IP"。这一点必须单独成模块并被表驱动测试钉死，因为它就是识破 trojan 假网站的唯一手段——trojan 服务端在密码错误时会返回一个正常的 HTML 页面，TCP / TLS / 握手三段全部成功，只有"响应体不是 IP"能抓住它。

`packages/proxy/src/bytes.ts` 里虽然有 `parseIpv4Literal` / `parseIpv6Literal`，但它们是**私有的**（未 export），且返回的是字节组而非布尔值。这里需要自己的判定函数，不要试图去复用它们。

- [ ] **Step 1: 写失败的测试**

新建 `vnext/packages/gateway/tests/egress-probe.test.ts`：

```ts
/**
 * 出口探针的 IP 形状判定。
 *
 * 这两个谓词是连通性测试唯一的"真的通了"证据：trojan 服务端在密码错误时
 * 按设计返回一个假网站，TCP / TLS / 握手全部成功，只有"锚点回显的响应体
 * 是一个合法 IP"能把这种情况和真正连通区分开。判错方向都很贵——放过一个
 * HTML 片段会把坏密码报成 ok，误杀一个合法 IPv6 会把好节点报成坏。
 */
import { test, expect } from 'bun:test'
import { ANCHORS, isIpV4, isIpV6 } from '../src/control-plane/proxies/egress-probe.ts'

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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
bun test packages/gateway/tests/egress-probe.test.ts
```

预期：失败，报无法解析 `../src/control-plane/proxies/egress-probe.ts`。

- [ ] **Step 3: 实现**

新建 `vnext/packages/gateway/src/control-plane/proxies/egress-probe.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/gateway/tests/egress-probe.test.ts
```

预期：全绿（30 余条）。

- [ ] **Step 5: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && git add packages/gateway/src/control-plane/proxies/egress-probe.ts packages/gateway/tests/egress-probe.test.ts && git commit -m "feat(gateway): add egress anchor table and IP-shape predicates"
```

---

### Task 5: `POST /api/proxies/test` 路由

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/proxies/routes.ts`
- Test: `vnext/packages/gateway/tests/control-plane-proxies.test.ts`

背景：把 Task 4 的判定接到真实隧道上。请求体带一个**完整 proxy URI**（而不是 proxy id），这样 dashboard 上"还没保存的草稿"也能测；路由本身在 `proxiesRouter` 内，已被那个 `use('*')` 的 admin 闸门覆盖，非管理员拿不到 403 之外的任何东西。

要用到的既有签名（不要改）：

```ts
// @vibe-core/proxy
runProxiedRequest(
  config: ProxyConfig,
  target: ProxyRequestTarget,        // { host: string; port: number; tls: boolean }
  request: HttpRequest,              // { method, path, headers, body? }
  options: RunProxiedRequestOptions, // { socketDial: SocketDial; signal?; dialTimeoutMs? }
): Promise<Response>

// @vibe-core/platform
getSocketDial(): SocketDial
```

`ProxyDialError` 带一个 `stage` 字段，取值为 `'config' | 'tcp-connect' | 'outer-tls' | 'proxy-handshake' | 'inner-tls'`，回给前端时拼成 `[stage] message` 便于定位失败环节。

- [ ] **Step 1: 写失败的测试**

在 `vnext/packages/gateway/tests/control-plane-proxies.test.ts` 顶部的 import 区补一行（放在既有 import 之后）：

```ts
import { initSocketDial, __resetPlatform } from '@vibe-core/platform'
```

如果 `@vibe-core/platform` 没有导出 `__resetPlatform`，就只 import `initSocketDial`；用下面这条确认：

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && grep -rn "export" packages/platform/src/index.ts | grep -i "reset\|socketDial"
```

然后在文件末尾追加：

```ts
/**
 * POST /api/proxies/test —— 连通性测试。
 *
 * 用一个假的 SocketDial 顶掉真实网络：它按脚本吐出一段 HTTP/1.1 响应，
 * 于是"锚点回显了什么"完全可控。这正是本路由的判定核心 —— trojan 服务端
 * 在密码错误时返回假网站，只有响应体不是 IP 这一点能抓住它，所以"响应体
 * 是 HTML"必须是一条独立用例。
 */

/** 组装一段完整的 HTTP/1.1 响应字节流。 */
function httpResponse(body: string): Uint8Array {
  const bytes = new TextEncoder().encode(body)
  const head = `HTTP/1.1 200 OK\r\ncontent-length: ${bytes.byteLength}\r\nconnection: close\r\n\r\n`
  const headBytes = new TextEncoder().encode(head)
  const out = new Uint8Array(headBytes.byteLength + bytes.byteLength)
  out.set(headBytes, 0)
  out.set(bytes, headBytes.byteLength)
  return out
}

/**
 * 一个只会回放固定字节的 SocketDial。写入的字节被丢弃 —— 本组用例测的是
 * 路由如何解读响应，不是握手的字节格式（那由 packages/proxy 自己的用例覆盖）。
 */
function scriptedSocketDial(responseBytes: Uint8Array) {
  return {
    connect: async () => ({
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(responseBytes)
          controller.close()
        },
      }),
      writable: new WritableStream<Uint8Array>({ write() {} }),
      close: async () => {},
    }),
  }
}

/** 一个 connect 就抛 ProxyDialError 的 SocketDial。 */
function failingSocketDial(message: string) {
  return {
    connect: async (): Promise<never> => {
      throw new Error(message)
    },
  }
}

async function postTest(body: Record<string, unknown>, auth: ProxyAuthCtx = { isAdmin: true }) {
  const res = await buildApp(auth).request('/api/proxies/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { res, body: (await res.json()) as any }
}

// HTTP CONNECT 代理是这组用例里最省事的载体：它的"握手"就是明文的
// `HTTP/1.1 200`，可以和随后的锚点响应拼在同一段脚本字节里。
const HTTP_PROXY_URL = 'http://proxy.example.com:8080'
const CONNECT_OK = new TextEncoder().encode('HTTP/1.1 200 Connection Established\r\n\r\n')

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

test('POST /api/proxies/test 非管理员 → 403', async () => {
  const { res } = await postTest({ url: HTTP_PROXY_URL }, {})
  expect(res.status).toBe(403)
})

test('POST /api/proxies/test 无法解析的 URI → 400', async () => {
  const { res, body } = await postTest({ url: 'gopher://nope:1080' })
  expect(res.status).toBe(400)
  expect(body.error).toMatch(/gopher/)
})

test('POST /api/proxies/test 锚点回显合法 IP → ok:true 带 egressIp', async () => {
  initSocketDial(scriptedSocketDial(concatBytes(CONNECT_OK, httpResponse('203.0.113.7\n'))))
  const { res, body } = await postTest({ url: HTTP_PROXY_URL })
  expect(res.status).toBe(200)
  expect(body.ok).toBe(true)
  expect(body.egressIp).toBe('203.0.113.7')
})

test('POST /api/proxies/test 响应体不是 IP（trojan 假网站）→ ok:false', async () => {
  initSocketDial(scriptedSocketDial(concatBytes(CONNECT_OK, httpResponse('<html><body>Welcome</body></html>'))))
  const { res, body } = await postTest({ url: HTTP_PROXY_URL })
  expect(res.status).toBe(200)
  expect(body.ok).toBe(false)
  expect(body.egressIp).toBeUndefined()
  // 报错文案不得回显响应体本身：假网站可能夹带任意内容。
  expect(JSON.stringify(body)).not.toMatch(/Welcome/)
})

test('POST /api/proxies/test v6 锚点却回显 v4 → ok:false', async () => {
  initSocketDial(scriptedSocketDial(concatBytes(CONNECT_OK, httpResponse('203.0.113.7'))))
  const { res, body } = await postTest({ url: HTTP_PROXY_URL, anchor: 'ident.me-v6' })
  expect(res.status).toBe(200)
  expect(body.ok).toBe(false)
})

test('POST /api/proxies/test 拨号失败 → ok:false 且错误带 stage 前缀', async () => {
  initSocketDial(failingSocketDial('ECONNREFUSED'))
  const { res, body } = await postTest({ url: HTTP_PROXY_URL })
  expect(res.status).toBe(200)
  expect(body.ok).toBe(false)
  expect(body.error).toMatch(/^\[(config|tcp-connect|outer-tls|proxy-handshake|inner-tls)\]/)
})

test('POST /api/proxies/test 报错不得回显 proxy URI（密码泄漏）', async () => {
  initSocketDial(failingSocketDial('ECONNREFUSED'))
  const { body } = await postTest({ url: 'trojan://sup3rs3cret@node1.example.com:443' })
  expect(JSON.stringify(body)).not.toMatch(/sup3rs3cret/)
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/gateway/tests/control-plane-proxies.test.ts
```

预期：新增用例全部失败（404，因为路由还不存在）。既有的 CRUD 用例仍应通过。

- [ ] **Step 3: 实现**

在 `vnext/packages/gateway/src/control-plane/proxies/routes.ts` 顶部补 import：

```ts
import { ProxyDialError, runProxiedRequest } from '@vibe-core/proxy'
import { getSocketDial } from '@vibe-core/platform'
import { ANCHORS, isIpV4, isIpV6 } from './egress-probe.ts'
```

在 `proxiesRouter.get('/backoffs', …)` 之后、`createBody` 之前插入：

```ts
const testBody = z.object({
  url: z.string().min(1),
  dialTimeoutSeconds: z.number().int().positive().nullish(),
  anchor: z.enum(['ipify', 'aws', 'ident.me-v6']).optional(),
})

/**
 * 连通性测试：走真实隧道向一个外部锚点发 GET，把响应体当作出口 IP 回显。
 *
 * 判定标准刻意是"响应体是一个合法 IP"而不是"连上了" —— trojan 服务端在
 * 密码错误时按设计返回一个假网站，TCP / TLS / 握手三段全部成功，只有校验
 * 响应体形状能把认证失败和真正连通区分开。
 *
 * 接受完整 URI 而不是 proxy id，这样 dashboard 上尚未保存的草稿也能测。
 */
proxiesRouter.post('/test', async (c) => {
  const parsed = testBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)

  let config
  try {
    config = parseProxyUri(parsed.data.url.trim())
  } catch (err) {
    // ProxyUriError 的 message 会回显冒犯的 URI，而 trojan URI 里带密码。
    // 只有 scheme 是安全可回显的，其余一律折叠成一句通用文案。
    const scheme = parsed.data.url.trim().split(':')[0] ?? ''
    void err
    return c.json({ error: `unsupported or malformed proxy URI (scheme: ${scheme})` }, 400)
  }

  const anchor = ANCHORS[parsed.data.anchor ?? 'ipify']
  const dialTimeoutMs = parsed.data.dialTimeoutSeconds
    ? parsed.data.dialTimeoutSeconds * 1000
    : undefined

  try {
    const res = await runProxiedRequest(
      config,
      { host: anchor.host, port: anchor.port, tls: true },
      {
        method: 'GET',
        path: anchor.path,
        headers: { host: anchor.host, 'user-agent': 'vibe-proxy-test/1', connection: 'close' },
      },
      { socketDial: getSocketDial(), ...(dialTimeoutMs === undefined ? {} : { dialTimeoutMs }) },
    )
    // 只取开头一小段：假网站可能返回任意长度的正文，没必要全读进内存。
    const text = (await res.text()).slice(0, 256).trim()
    if (parsed.data.anchor === 'ident.me-v6' ? !isIpV6(text) : !(isIpV4(text) || isIpV6(text))) {
      // 不回显 text 本身 —— 它可能是攻击者控制的任意内容。
      return c.json({ ok: false, error: 'anchor did not return an IP address' })
    }
    return c.json({ ok: true, egressIp: text })
  } catch (err) {
    if (err instanceof ProxyDialError) {
      return c.json({ ok: false, error: `[${err.stage}] ${err.message}` })
    }
    throw err
  }
})
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/gateway/tests/control-plane-proxies.test.ts
```

预期：全绿。若"拨号失败"那条没有拿到 `[stage]` 前缀，说明底层把普通 `Error` 原样抛出而没有包成 `ProxyDialError`——此时把 `failingSocketDial` 里抛出的错误换成 `ProxyDialError` 的构造（`new ProxyDialError('ECONNREFUSED', 'tcp-connect')`，需在测试文件 import 它），并在提交信息里记一句。

- [ ] **Step 5: typecheck**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run --filter '@vibe-llm/gateway' typecheck
```

预期：退出码 0。

- [ ] **Step 6: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && git add packages/gateway/src/control-plane/proxies/routes.ts packages/gateway/tests/control-plane-proxies.test.ts && git commit -m "feat(gateway): add POST /api/proxies/test echoing egress IP"
```

---

### Task 6: Dashboard 表单纯逻辑层

**Files:**
- Modify: `vnext/apps/dashboard/package.json`
- Create: `vnext/apps/dashboard/src/tabs/proxies/proxy-form-config.ts`
- Test: `vnext/apps/dashboard/src/tabs/proxies/proxy-form-config.test.ts`（新建）

背景：表单的所有判断——"这个协议要填哪些字段"、"当前该以 URL 还是结构化字段为准"、"哪一格是空的"——全部收在这个纯模块里，`ProxyForm.tsx` 只负责渲染。这样这些规则可以被 `bun test` 直接覆盖，不需要渲染 React。

Dashboard 目前没有依赖 `@vibe-core/proxy`。`packages/proxy/src/url.ts` 只 import `./errors.ts`、`./proxy-config.ts` 和（Task 3 之后）`./bytes.ts`，用到的运行时 API 只有 `URL` / `atob` / `btoa` / `TextEncoder`，全部浏览器可用，所以可以安全打进前端 bundle。

**9 个 FormKind ↔ ProxyConfig ↔ 默认端口对照表**（`http` 按 `tls` 拆成两个 FormKind，其余一一对应）：

| FormKind | ProxyConfig | 默认端口 | 除 host/port 外的必填 |
|---|---|---|---|
| `http` | `{kind:'http', tls:false}` | 8080 | — |
| `https` | `{kind:'http', tls:true}` | 443 | — |
| `socks5` | `{kind:'socks5'}` | 1080 | — |
| `ss` | `{kind:'ss'}` | 8388 | `password` |
| `ss2022` | `{kind:'ss2022'}` | 8388 | `passwordBase64` |
| `trojan` | `{kind:'trojan'}` | 443 | `password` |
| `vless-tcp` | `{kind:'vless-tcp'}` | 443 | `uuid` |
| `vless-ws` | `{kind:'vless-ws'}` | 443 | `uuid`、`path` |
| `reality` | `{kind:'reality'}` | 443 | `uuid`、`publicKey`、`serverName` |

- [ ] **Step 1: 加依赖**

在 `vnext/apps/dashboard/package.json` 的 `dependencies` 中，`"@vibe-llm/protocols": "workspace:*",` 这一行之后插入：

```json
    "@vibe-core/proxy": "workspace:*",
```

然后：

```bash
bun install
```

- [ ] **Step 2: 写失败的测试**

新建 `vnext/apps/dashboard/src/tabs/proxies/proxy-form-config.test.ts`：

```ts
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
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test apps/dashboard/src/tabs/proxies/proxy-form-config.test.ts
```

预期：失败，无法解析 `./proxy-form-config.ts`。

- [ ] **Step 4: 实现**

新建 `vnext/apps/dashboard/src/tabs/proxies/proxy-form-config.ts`：

```ts
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
   * 改动任一结构化字段会把它置回 `null`。
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
 * `formatProxyUri` 会产出 `://:443` 这种半成品，不如直接显示空串。
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

  if (d.url !== null && d.url.trim()) {
    if (!parseProxyUriSafe(d.url.trim())) issues.url = 'dash.proxyErrUrl'
  }

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

/** 草稿是否可提交 / 可测试。 */
export const draftIsValid = (d: ProxyDraft): boolean => {
  const i = draftIssues(d)
  return !i.name && !i.url && !i.dialTimeout && Object.keys(i.config).length === 0
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test apps/dashboard/src/tabs/proxies/proxy-form-config.test.ts
```

预期：全绿。

- [ ] **Step 6: typecheck**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run --filter '@vibe-llm/dashboard' typecheck
```

预期：退出码 0。若报 `Cannot find module '@vibe-core/proxy/url'`，说明 Step 1 的 `bun install` 没跑或 workspace 链接没建立，重跑一次。

- [ ] **Step 7: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && git add apps/dashboard/package.json apps/dashboard/src/tabs/proxies/proxy-form-config.ts apps/dashboard/src/tabs/proxies/proxy-form-config.test.ts bun.lock && git commit -m "feat(dashboard): add pure form logic for all nine proxy kinds"
```

（若 `bun.lock` 未变动就从 `git add` 里去掉它。）

---

### Task 7: `ProxyForm.tsx` 受控表单

**Files:**
- Create: `vnext/apps/dashboard/src/tabs/proxies/ProxyForm.tsx`

背景：纯渲染层，所有规则来自 Task 6。这里唯一的逻辑是双向同步的两个 handler，规则来自 spec §2：

1. **改结构化字段** → 更新 `config`，并把 `url` 置 `null`（回到"以字段为准"）。
2. **改 URL 框** → `url` 存用户原文；若能解析成功则同步覆盖 `config`；解析失败就只留 URL，让 `draftIssues` 去报错。
3. **切协议** → 走规则 1，用 `defaultsFor(next, {host, port, name})` 保留 host/port/name。切协议时如果当前 port 恰好等于旧协议的默认端口，就换成新协议的默认端口——用户没手动改过端口时这才是他要的。

样式沿用 `ProxiesTab.tsx` 已有的词汇：`bg-surface-900 border border-surface-600 rounded-lg p-3`、`text-themed-dim`、`text-accent-red`、`btn-primary !text-xs !py-1 !px-3`、`btn-ghost !text-xs !py-1 !px-2`。

- [ ] **Step 1: 实现**

新建 `vnext/apps/dashboard/src/tabs/proxies/ProxyForm.tsx`：

```tsx
/**
 * 代理节点的结构化编辑表单。
 *
 * URL 输入框和结构化字段双向同步：改字段会把 `draft.url` 置回 `null`
 * （表示"以字段为准"，URL 框转为显示推导结果）；改 URL 框会存下原文，
 * 能解析就顺带覆盖字段。校验规则全部来自 proxy-form-config.ts。
 */
import { useT } from '../../state/i18n'
import type { ProxyConfig } from '@vibe-core/proxy/proxy-config'
import {
  DEFAULT_PORTS,
  FORM_KINDS,
  type FormKind,
  type ProxyDraft,
  defaultsFor,
  draftIssues,
  draftUrl,
  formKindOf,
  parseProxyUriSafe,
} from './proxy-form-config'

const INPUT_CLS =
  'w-full bg-surface-800 border border-surface-600 rounded px-2 py-1 text-xs font-mono'

function Field(props: {
  label: string
  value: string
  error?: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  const t = useT()
  return (
    <label className="block">
      <span className="block text-[11px] text-themed-dim mb-0.5">{props.label}</span>
      <input
        className={INPUT_CLS}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.error ? (
        <span className="block text-[11px] text-accent-red mt-0.5">{t(props.error)}</span>
      ) : null}
    </label>
  )
}

export function ProxyForm(props: {
  draft: ProxyDraft
  onChange: (next: ProxyDraft) => void
}) {
  const t = useT()
  const { draft, onChange } = props
  const issues = draftIssues(draft)
  const kind = formKindOf(draft.config)

  /** 规则 1：改结构化字段 → 回到"以字段为准"。 */
  const setConfig = (update: (prev: ProxyConfig) => ProxyConfig) => {
    onChange({ ...draft, config: update(draft.config), url: null })
  }

  /** 规则 2：改 URL 框 → 存原文，能解析就同步字段。 */
  const setUrl = (raw: string) => {
    const trimmed = raw.trim()
    const parsed = trimmed ? parseProxyUriSafe(trimmed) : null
    onChange(parsed ? { ...draft, url: raw, config: parsed } : { ...draft, url: raw })
  }

  /** 规则 3：切协议 → 保留 host/name；端口没被手动改过就换成新协议的默认值。 */
  const setKind = (next: FormKind) => {
    const port = draft.config.port === DEFAULT_PORTS[kind] ? DEFAULT_PORTS[next] : draft.config.port
    setConfig((prev) => defaultsFor(next, { host: prev.host, port, name: prev.name }))
  }

  const setPort = (raw: string) => {
    const n = raw.trim() === '' ? 0 : Number(raw)
    setConfig((prev) => ({ ...prev, port: Number.isFinite(n) ? n : 0 }))
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t('dash.proxyNameLabel')}
          value={draft.name}
          error={issues.name}
          onChange={(v) => onChange({ ...draft, name: v, url: null })}
        />
        <label className="block">
          <span className="block text-[11px] text-themed-dim mb-0.5">{t('dash.proxyKindLabel')}</span>
          <select
            className={INPUT_CLS}
            value={kind}
            onChange={(e) => setKind(e.target.value as FormKind)}
          >
            {FORM_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t('dash.proxyHostLabel')}
          value={draft.config.host}
          error={issues.config.host}
          placeholder="node1.example.com"
          onChange={(v) => setConfig((prev) => ({ ...prev, host: v }))}
        />
        <Field
          label={t('dash.proxyPortLabel')}
          value={draft.config.port ? String(draft.config.port) : ''}
          error={issues.config.port}
          placeholder={String(DEFAULT_PORTS[kind])}
          onChange={setPort}
        />
      </div>

      <KindFields config={draft.config} issues={issues.config} setConfig={setConfig} />

      <Field
        label={t('dash.proxyDialTimeoutLabel')}
        value={draft.dialTimeoutSeconds}
        error={issues.dialTimeout}
        placeholder={t('dash.proxyDialTimeoutDefault')}
        onChange={(v) => onChange({ ...draft, dialTimeoutSeconds: v })}
      />

      <Field
        label={t('dash.proxyUrlLabel')}
        value={draftUrl(draft)}
        error={issues.url}
        placeholder="trojan://password@host:443"
        onChange={setUrl}
      />
      <p className="text-[11px] text-themed-dim">{t('dash.proxyUrlSyncHint')}</p>
    </div>
  )
}

/** 每种协议各自的字段。共有的 host / port 已在上面渲染过。 */
function KindFields(props: {
  config: ProxyConfig
  issues: Record<string, string | undefined>
  setConfig: (update: (prev: ProxyConfig) => ProxyConfig) => void
}) {
  const t = useT()
  const { config, issues, setConfig } = props

  switch (config.kind) {
  case 'http':
  case 'socks5':
    return (
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t('dash.proxyUsernameLabel')}
          value={config.username ?? ''}
          onChange={(v) => setConfig((prev) => ({ ...prev, username: v || undefined }))}
        />
        <Field
          label={t('dash.proxyPasswordLabel')}
          value={config.password ?? ''}
          onChange={(v) => setConfig((prev) => ({ ...prev, password: v || undefined }))}
        />
      </div>
    )
  case 'ss':
    return (
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[11px] text-themed-dim mb-0.5">{t('dash.proxyMethodLabel')}</span>
          <select
            className={INPUT_CLS}
            value={config.method}
            onChange={(e) => setConfig((prev) => ({ ...prev, method: e.target.value }) as ProxyConfig)}
          >
            <option value="aes-128-gcm">aes-128-gcm</option>
            <option value="aes-256-gcm">aes-256-gcm</option>
            <option value="chacha20-ietf-poly1305">chacha20-ietf-poly1305</option>
          </select>
        </label>
        <Field
          label={t('dash.proxyPasswordLabel')}
          value={config.password}
          error={issues.password}
          onChange={(v) => setConfig((prev) => ({ ...prev, password: v }) as ProxyConfig)}
        />
      </div>
    )
  case 'ss2022':
    return (
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[11px] text-themed-dim mb-0.5">{t('dash.proxyMethodLabel')}</span>
          <select
            className={INPUT_CLS}
            value={config.method}
            onChange={(e) => setConfig((prev) => ({ ...prev, method: e.target.value }) as ProxyConfig)}
          >
            <option value="2022-blake3-aes-128-gcm">2022-blake3-aes-128-gcm</option>
            <option value="2022-blake3-aes-256-gcm">2022-blake3-aes-256-gcm</option>
            <option value="2022-blake3-chacha20-poly1305">2022-blake3-chacha20-poly1305</option>
          </select>
        </label>
        <Field
          label={t('dash.proxyPskLabel')}
          value={config.passwordBase64}
          error={issues.passwordBase64}
          onChange={(v) => setConfig((prev) => ({ ...prev, passwordBase64: v }) as ProxyConfig)}
        />
      </div>
    )
  case 'trojan':
    return (
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t('dash.proxyPasswordLabel')}
          value={config.password}
          error={issues.password}
          onChange={(v) => setConfig((prev) => ({ ...prev, password: v }) as ProxyConfig)}
        />
        <Field
          label={t('dash.proxySniLabel')}
          value={config.sni ?? ''}
          onChange={(v) => setConfig((prev) => ({ ...prev, sni: v || undefined }) as ProxyConfig)}
        />
      </div>
    )
  case 'vless-tcp':
    return (
      <Field
        label={t('dash.proxyUuidLabel')}
        value={config.uuid}
        error={issues.uuid}
        onChange={(v) => setConfig((prev) => ({ ...prev, uuid: v }) as ProxyConfig)}
      />
    )
  case 'vless-ws':
    return (
      <div className="grid grid-cols-3 gap-2">
        <Field
          label={t('dash.proxyUuidLabel')}
          value={config.uuid}
          error={issues.uuid}
          onChange={(v) => setConfig((prev) => ({ ...prev, uuid: v }) as ProxyConfig)}
        />
        <Field
          label={t('dash.proxyWsPathLabel')}
          value={config.path}
          error={issues.path}
          placeholder="/"
          onChange={(v) => setConfig((prev) => ({ ...prev, path: v }) as ProxyConfig)}
        />
        <Field
          label={t('dash.proxyWsHostLabel')}
          value={config.wsHost ?? ''}
          onChange={(v) => setConfig((prev) => ({ ...prev, wsHost: v || undefined }) as ProxyConfig)}
        />
      </div>
    )
  case 'reality':
    return (
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t('dash.proxyUuidLabel')}
          value={config.uuid}
          error={issues.uuid}
          onChange={(v) => setConfig((prev) => ({ ...prev, uuid: v }) as ProxyConfig)}
        />
        <Field
          label={t('dash.proxyPublicKeyLabel')}
          value={config.publicKey}
          error={issues.publicKey}
          onChange={(v) => setConfig((prev) => ({ ...prev, publicKey: v }) as ProxyConfig)}
        />
        <Field
          label={t('dash.proxyServerNameLabel')}
          value={config.serverName}
          error={issues.serverName}
          onChange={(v) => setConfig((prev) => ({ ...prev, serverName: v }) as ProxyConfig)}
        />
        <Field
          label={t('dash.proxyShortIdLabel')}
          value={config.shortId ?? ''}
          onChange={(v) => setConfig((prev) => ({ ...prev, shortId: v || undefined }) as ProxyConfig)}
        />
      </div>
    )
  }
}
```

**关于 `as ProxyConfig`：** 本仓库禁止 `as any` / `as unknown as X` / `as never`。这里出现的 `as ProxyConfig` 是在判别联合的某个分支内部做 spread 展宽——TypeScript 无法从 `{...prev, password: v}` 推回具体分支。若实现时能通过给每个分支写显式的完整对象字面量（例如 `{ kind: 'trojan', host: prev.host, port: prev.port, name: prev.name, password: v, sni: prev.sni, allowInsecure: prev.allowInsecure }`）来去掉这些断言，**优先那样做**；确实去不掉的位置保留断言，并在该行上方写一句为什么。

- [ ] **Step 2: typecheck**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run --filter '@vibe-llm/dashboard' typecheck
```

预期：退出码 0。

- [ ] **Step 3: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && git add apps/dashboard/src/tabs/proxies/ProxyForm.tsx && git commit -m "feat(dashboard): add structured per-protocol proxy form"
```

---

### Task 8: 接线 ProxiesTab + 测试按钮 + i18n

**Files:**
- Modify: `vnext/apps/dashboard/src/api/proxies.ts`
- Modify: `vnext/apps/dashboard/src/tabs/proxies/ProxiesTab.tsx`
- Modify: `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts`

背景：把 Task 7 的表单挂进现有 Tab，替换掉原来那个裸 URL 输入框；同时加"测试连通性"按钮，调 Task 5 的路由。

**i18n 硬性约束：** `packages/gateway/tests/i18n-keys.test.ts` 会扫描 dashboard 源码里所有 `t("...")`，断言每个 key 在 `renderI18nScript()` 的 `en` 和 `zh` 两份字典里都存在。**漏一个 key 就会红。** 所以 Step 3 必须把下面全部 21 个新 key 同时加进两份字典。

- [ ] **Step 1: `testProxy()` API**

在 `vnext/apps/dashboard/src/api/proxies.ts` 的 `resetBackoffs` 之后（第 65 行 `}` 之后）插入：

```ts
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
```

- [ ] **Step 2: 改 ProxiesTab.tsx**

改动分四处。

**(a) 第 1-14 行的 import 块**，整体替换为：

```tsx
import { useCallback, useEffect, useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import { ApiError } from "../../api/client"
import {
  listProxies,
  listBackoffs,
  createProxy,
  patchProxy,
  deleteProxy,
  resetBackoffs,
  testProxy,
  type ProxyRecord,
  type ProxyBackoffRow,
  type ProxyTestAnchor,
  type ProxyTestResult,
} from "../../api/proxies"
import { ProxyForm } from "./ProxyForm"
import {
  type ProxyDraft,
  defaultsFor,
  draftIsValid,
  draftUrl,
  parseProxyUriSafe,
} from "./proxy-form-config"
```

**(b) 第 25 行的 `EMPTY_DRAFT`**，替换为：

```tsx
const ANCHORS: ProxyTestAnchor[] = ["ipify", "aws", "ident.me-v6"]

const EMPTY_DRAFT: ProxyDraft = {
  name: "",
  // 新建时默认落在 trojan —— 这是本部署里最常用的形态。
  config: defaultsFor("trojan", { host: "", port: 443, name: "" }),
  url: null,
  dialTimeoutSeconds: "",
}
```

**(c) 第 34-36 行的 state 声明**，在 `const [creating, setCreating] = useState(false)` 之后补三行：

```tsx
  const [anchor, setAnchor] = useState<ProxyTestAnchor>("ipify")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null)
```

并把 `const [draft, setDraft] = useState(EMPTY_DRAFT)` 改成：

```tsx
  const [draft, setDraft] = useState<ProxyDraft>(EMPTY_DRAFT)
```

**(d) 第 52-79 行的 `startEdit` 与 `submit`**，整体替换为下面这段（并在其后新增 `runTest`）：

```tsx
  const startEdit = (p: ProxyRecord) => {
    setEditingId(p.id)
    setCreating(false)
    setTestResult(null)
    const parsed = parseProxyUriSafe(p.url)
    setDraft({
      name: p.name,
      // 存量行的 URL 理应都能解析（写入时 POST/PATCH 校验过），但历史数据
      // 或手工改库可能留下解析不了的行 —— 那种情况退回纯 URL 编辑模式，
      // 让管理员至少能看到并修正它，而不是被空表单挡住。
      config: parsed ?? EMPTY_DRAFT.config,
      url: parsed ? null : p.url,
      dialTimeoutSeconds: p.dialTimeoutSeconds == null ? "" : String(p.dialTimeoutSeconds),
    })
  }

  const closeForm = () => {
    setCreating(false)
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setTestResult(null)
  }

  const submit = async () => {
    const secs = draft.dialTimeoutSeconds.trim()
    const body = {
      name: draft.name.trim(),
      url: draftUrl(draft).trim(),
      dialTimeoutSeconds: secs ? Number(secs) : null,
    }
    try {
      if (editingId) await patchProxy(editingId, body)
      else await createProxy(body)
      closeForm()
      await reload()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  const runTest = async () => {
    const secs = draft.dialTimeoutSeconds.trim()
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await testProxy({
        url: draftUrl(draft).trim(),
        dialTimeoutSeconds: secs ? Number(secs) : null,
        anchor,
      }))
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }
```

**(e) 第 126-163 行的表单块**（`{creating || editingId ? (` 到对应的 `) : null}`），整体替换为：

```tsx
      {creating || editingId ? (
        <div className="bg-surface-900 border border-surface-600 rounded-lg p-3 space-y-2">
          <ProxyForm draft={draft} onChange={setDraft} />

          <div className="flex gap-2 items-center flex-wrap">
            <button
              onClick={submit}
              disabled={!draftIsValid(draft)}
              className="btn-primary !text-xs !py-1 !px-3 disabled:opacity-40"
            >
              {t("dash.save")}
            </button>
            <button
              onClick={runTest}
              disabled={testing || !draftIsValid(draft)}
              className="btn-ghost !text-xs !py-1 !px-3 disabled:opacity-40"
            >
              {testing ? t("dash.proxyTestRunning") : t("dash.proxyTestBtn")}
            </button>
            <select
              value={anchor}
              onChange={(e) => setAnchor(e.target.value as ProxyTestAnchor)}
              title={t("dash.proxyAnchorLabel")}
              className="bg-surface-800 border border-surface-600 rounded px-2 py-1 text-xs"
            >
              {ANCHORS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <button onClick={closeForm} className="btn-ghost !text-xs !py-1 !px-3">
              {t("dash.closeBtn")}
            </button>
          </div>

          {testResult ? (
            <div
              className={`text-xs font-mono break-all ${
                testResult.ok ? "text-themed" : "text-accent-red"
              }`}
            >
              {testResult.ok
                ? t("dash.proxyTestOk", { ip: testResult.egressIp })
                : t("dash.proxyTestFail", { err: testResult.error })}
            </div>
          ) : null}
        </div>
      ) : null}
```

**(f)** 原来那个"新建节点"按钮（第 114-123 行）里的 `setDraft(EMPTY_DRAFT)` 之后补一行 `setTestResult(null)`：

```tsx
          onClick={() => {
            setCreating(true)
            setEditingId(null)
            setDraft(EMPTY_DRAFT)
            setTestResult(null)
          }}
```

- [ ] **Step 3: 加 i18n key（EN + ZH 两处都要加）**

打开 `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts`。找到 `en` 字典里已有的 `'dash.proxyRevealTip'` 那一行，在它之后插入下面 21 行：

```ts
      'dash.proxyKindLabel': 'Protocol',
      'dash.proxyHostLabel': 'Host',
      'dash.proxyPortLabel': 'Port',
      'dash.proxyUrlLabel': 'Proxy URL',
      'dash.proxyUrlSyncHint': 'Edit either the fields or the URL — they stay in sync.',
      'dash.proxyUsernameLabel': 'Username (optional)',
      'dash.proxyPasswordLabel': 'Password',
      'dash.proxyMethodLabel': 'Cipher',
      'dash.proxyPskLabel': 'PSK (base64)',
      'dash.proxySniLabel': 'SNI (optional)',
      'dash.proxyUuidLabel': 'UUID',
      'dash.proxyWsPathLabel': 'WebSocket path',
      'dash.proxyWsHostLabel': 'WebSocket Host header (optional)',
      'dash.proxyPublicKeyLabel': 'Public key',
      'dash.proxyServerNameLabel': 'Server name',
      'dash.proxyShortIdLabel': 'Short ID (optional)',
      'dash.proxyAnchorLabel': 'Echo anchor',
      'dash.proxyTestBtn': 'Test connectivity',
      'dash.proxyTestRunning': 'Testing…',
      'dash.proxyTestOk': 'Egress IP: {ip}',
      'dash.proxyTestFail': 'Failed: {err}',
```

紧接着再插入这 10 个校验文案：

```ts
      'dash.proxyErrName': 'Name is required',
      'dash.proxyErrHost': 'Host is required',
      'dash.proxyErrPort': 'Port must be 1–65535',
      'dash.proxyErrPassword': 'Password is required',
      'dash.proxyErrUuid': 'UUID is required',
      'dash.proxyErrPublicKey': 'Public key is required',
      'dash.proxyErrServerName': 'Server name is required',
      'dash.proxyErrPath': 'Path is required',
      'dash.proxyErrUrl': 'Cannot parse this proxy URL',
      'dash.proxyErrDialTimeout': 'Must be a positive whole number of seconds',
```

然后在 `zh` 字典里同样找到 `'dash.proxyRevealTip'`，在它之后插入对应的 31 行：

```ts
      'dash.proxyKindLabel': '协议',
      'dash.proxyHostLabel': '主机',
      'dash.proxyPortLabel': '端口',
      'dash.proxyUrlLabel': '代理 URL',
      'dash.proxyUrlSyncHint': '改字段或改 URL 都可以，两者会自动同步。',
      'dash.proxyUsernameLabel': '用户名（可选）',
      'dash.proxyPasswordLabel': '密码',
      'dash.proxyMethodLabel': '加密方式',
      'dash.proxyPskLabel': 'PSK（base64）',
      'dash.proxySniLabel': 'SNI（可选）',
      'dash.proxyUuidLabel': 'UUID',
      'dash.proxyWsPathLabel': 'WebSocket 路径',
      'dash.proxyWsHostLabel': 'WebSocket Host 头（可选）',
      'dash.proxyPublicKeyLabel': '公钥',
      'dash.proxyServerNameLabel': '伪装域名',
      'dash.proxyShortIdLabel': 'Short ID（可选）',
      'dash.proxyAnchorLabel': '回显锚点',
      'dash.proxyTestBtn': '测试连通性',
      'dash.proxyTestRunning': '测试中…',
      'dash.proxyTestOk': '出口 IP：{ip}',
      'dash.proxyTestFail': '失败：{err}',
      'dash.proxyErrName': '请填写名称',
      'dash.proxyErrHost': '请填写主机',
      'dash.proxyErrPort': '端口需在 1–65535 之间',
      'dash.proxyErrPassword': '请填写密码',
      'dash.proxyErrUuid': '请填写 UUID',
      'dash.proxyErrPublicKey': '请填写公钥',
      'dash.proxyErrServerName': '请填写伪装域名',
      'dash.proxyErrPath': '请填写路径',
      'dash.proxyErrUrl': '无法解析该代理 URL',
      'dash.proxyErrDialTimeout': '请填写正整数秒',
```

- [ ] **Step 4: 跑 i18n gate**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/gateway/tests/i18n-keys.test.ts
```

预期：通过。若报某个 key 缺失，说明上面漏抄了一行——按报出的 key 补齐，**en 和 zh 都要有**。

- [ ] **Step 5: typecheck**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run typecheck
```

预期：退出码 0。

- [ ] **Step 6: 全量测试**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test
```

预期：全绿。（`bun test` 前置会跑 `build:ui`，这一步同时验证了新组件能打进 dashboard bundle。）

- [ ] **Step 7: 提交**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && git add apps/dashboard/src/api/proxies.ts apps/dashboard/src/tabs/proxies/ProxiesTab.tsx packages/gateway/src/shared/edge/ui-pages/i18n.ts && git commit -m "feat(dashboard): wire structured proxy form and connectivity test into Proxies tab"
```

---

## 收尾

全部 8 个任务完成后：

1. 从仓库根跑一次完整 CI：`cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run ci:local`
2. 本地 Docker 构建 + 人工验证（用户自己做，不由实现方驱动）。
3. 保持在 `vNext` 分支，未经用户明确确认不合并到 `main`。
