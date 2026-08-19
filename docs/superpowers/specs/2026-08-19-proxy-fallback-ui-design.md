# Per-Upstream Proxy Fallback Chain UI

## Context

vNext 的代理转发能力在传输层已经完整可用，但**没有任何配置入口**。这份设计补上控制面路由和 dashboard UI。

### 已经就位的部分

- `packages/proxy` — 支持 `http`(CONNECT) / `socks5` / `ss` / `ss2022` / `trojan` / `vless-tcp` / `vless-ws` / `reality`，由 `dialer.ts` 的 `dispatchDial` 分发。
- `packages/dial/src/fetcher.ts` — 两遍拨号的故障转移walk。
- `packages/proxy-repo` — `ProxyRepo` / `ProxyBackoffRepo` / `normalizeProxyFallbackList`。
- `packages/gateway/src/repo/shared/repos.ts` — `SharedProxyRepo` / `SharedProxyBackoffRepo` 已挂进 repo composer。
- `packages/gateway/src/data-plane/dial/per-request.ts` — 数据面按 upstream 构建 fetcher。
- `migrations/0001_baseline.sql` — `proxies` 表、`proxy_upstream_backoffs` 表、`upstreams.proxy_fallback_list_json`。
- `control-plane/upstreams/routes.ts:304` `serializeUpstream` 是 `{...upstream}` 全展开，所以 **GET/list 已经在返回 `proxyFallbackList`**。
- 同文件 `:334` `adminFetcher` 让「测试上游 / 拉模型」也走同一条链，避免「唯一出口是代理的网关上 Test 失败但推理正常」。

Cloudflare Workers **能跑这些协议**：`apps/platform-cloudflare/src/cfw-socket-dial.ts` 用 `cloudflare:sockets` 的 `secureTransport: "off"` 拿裸 TCP 流。`trojan.ts` 在用户态同时做外层和内层 TLS，正是为了绕开 workerd TLS 把首个 application-data 写切成两个 record（~4 字节 + 其余）导致 sing-box trojan inbound 短读 56 字节 key 的问题。

### 缺的部分

1. `/api/proxies` 路由完全不存在。
2. `upstreamBody` zod 不收 `proxyFallbackList`；POST 在 `routes.ts:444` 硬编码 `[]`；PATCH 靠 `...existing` 只能保留不能改。
3. 全部 UI。

---

## 数据模型（既有，不改）

**两层结构**：

- `proxies` 表是**全局节点池**：`id / name / url / dialTimeoutSeconds`。一个节点录一次，所有 upstream 都能引用。
- `upstreams.proxy_fallback_list_json` 存**引用列表**：`[{ id, colos? }]`，只有 id，不复制节点配置。

两个**内置 id 不需要 DB 行**：`direct_connect`（裸 TCP）和 `direct_fetch`（运行时 fetch）。

### 「多个节点」的语义

**有序故障转移链，不是负载均衡，不是轮询。** 同一时刻只有一个节点承载流量。

`packages/dial/src/fetcher.ts:66-156` 的走法：

1. **colo 过滤** — 每个条目可带 `colos` 白名单。过滤后为空 → 退化成 `[direct_connect]`。
2. **第一遍** — 按顺序走，跳过处于 backoff 冷却期的节点。第一个拨通的胜出。
3. **第二遍** — 只走第一遍被跳过的（冷却中的）。既踢一脚恢复调度，又保证「所有节点都在冷却」时仍能服务。
4. 第一遍已失败的节点**不重试** —— 重试会把失败计数翻倍，扭曲 `60·2ⁿ`（封顶 3600s）的几何退避曲线。

**backoff 是 per-(proxy, upstream)** 的：节点 A 对 upstream X 挂了不影响它对 upstream Y 的可用性。成功一次清零。

**空链 / 未配置 = 隐式 `direct_connect`（裸 TCP），刻意不是 `direct_fetch`。** 原因见 `fetcher.ts:67-75`：两个运行时的 `fetch` 都会掐掉长时间没有新字节的响应体（CFW Proxy Read Timeout 120s；undici `bodyTimeout` 默认 300s），而这两个限制从代码里够不着。一个已返回 200、然后模型在思考的流式响应会被直接杀掉。裸 socket 无此限制。`direct_fetch` 保留连接池和 HTTP/2，所以仍可选，但需显式指定。

---

## 权限模型

`proxies.url` 形如 `trojan://password@host:port`，**密码在 URL 里**。而 Upstreams tab 是 `userOk: true`，普通用户能拥有并编辑自己的 upstream。

**决定：代理是运维基础设施，全部 admin-only。**

- `/api/proxies` 所有路由要求 admin。
- Proxies tab `adminOnly: true`。
- upstream 行上的「代理」按钮仅 admin 渲染。

普通用户的 upstream **不会因此强制直连** —— `loadOwned`（`control-plane/shared/ownership.ts:26`）对 admin 是 `if (isAdmin) return record`，admin 能编辑任何人的 upstream；数据面 `per-request.ts` 也完全不看 ownerId。所以实际含义是「不能自助」，不是「不能用」。

### 「半只读」

`UpstreamsTab.tsx:219` 现在是 `readOnly={!g.isMine}` —— 只读闸按**所有权**判，完全没看 isAdmin；`:227` 的 `editingId === u.id && g.isMine` 让别人的 upstream 连编辑表单都不渲染。

「admin 能给别人的 upstream 配代理，但别的还是只读」是个新状态。**实现方式是另开一个入口，不是给现有表单加模式** —— `UpstreamFormModal` 是 956 行，把 `readOnly` 穿进去逐个 disable 几十个输入框，风险高且收益全在别处。`locked` 的语义一个字不改。

---

## 后端

### 新增 `packages/gateway/src/control-plane/proxies/routes.ts`

全部 admin-only（沿用 `isAdmin(c)`，非 admin 403）：

| 路由 | 行为 |
|---|---|
| `GET /api/proxies` | 返回全部节点行 |
| `POST /api/proxies` | 建节点；先用 `parseProxyUri`（`packages/proxy/src/url.ts:59`）验 url，解析失败 400 带原因 |
| `PATCH /api/proxies/:id` | 改 `name` / `url` / `dialTimeoutSeconds` |
| `DELETE /api/proxies/:id` | `ProxyRepo.delete()` 返回 false 时 409，附 `findUpstreamsReferencing(id)` 的结果 |
| `GET /api/proxies/backoffs` | `listAll()`，一次拿全部冷却行 |
| `DELETE /api/proxies/:id/backoffs` | `resetForProxy(id)` |

挂进 `control-plane/routes.ts` 的 router 组合。

### 改 `control-plane/upstreams/routes.ts`

三处：

1. `upstreamBody` zod 加 `proxyFallbackList: z.array(z.object({ id: z.string(), colos: z.array(z.string()).optional() })).optional()`
2. POST — `:444` 的 `proxyFallbackList: []` 换成 `normalizeProxyFallbackList(body.proxyFallbackList ?? [])`
3. PATCH — 加 `proxyFallbackList: body.proxyFallbackList === undefined ? existing.proxyFallbackList : normalizeProxyFallbackList(body.proxyFallbackList)`

三点说明：

- **`normalizeProxyFallbackList` 已存在**（`packages/proxy-repo/src/fallback-list.ts:21`）：按 id 去重（首次出现的 `colos` 胜出）、colo 大写化、空数组转 `undefined`。不用新写。
- **不校验 id 是否真在 proxies 表里。** `fetcher.ts:179-186` 已把「链引用了不存在的 id」当作这一跳的拨号失败并继续走链，是刻意的：管理员在请求飞行途中删掉一行不该弄死整个调用。写入时再加一道校验只会制造两处不一致的真相。
- **不需要缓存失效。** `loadProxyCatalog`（`packages/dial/src/proxy-catalog.ts:31`）每请求现读 `proxies.list()`，无缓存层，CRUD 立即生效。

前端不需要新的读接口 —— `GET /api/upstreams` 已经在返 `proxyFallbackList`。

---

## 前端

### Proxies tab

`App.tsx:26` 的 `ALL_TABS` 加 `{ id: "proxies", labelKey: "dash.proxies", fallback: "Proxies", adminOnly: true }`。

节点表，每行：名称 / url（默认掩码，点击展开）/ 拨号超时 / 编辑 / 删除。

行可展开显示 **backoff 面板**：该节点对哪些 upstream 处于冷却、失败次数、冷却到期时间、最后一次错误。错误串带 `[stage]` 前缀（`fetcher.ts:240` 写入），能区分 tcp-connect 被拒和 inner-tls 证书不匹配。带「重置」按钮。

删除被 409 挡下时，列出引用它的 upstream。

### `ProxyChainEditor`（自包含组件）

入参 `upstreamId` + 当前 `proxyFallbackList`。

```
链（有序，从上往下试）
  1. [trojan-hk        ▾]  ↑ ↓ ✕
  2. [direct_connect   ▾]  ↑ ↓ ✕
  [+ 加一跳]  [+ 新建节点…]
```

- 下拉选项 = `direct_connect` + `direct_fetch` + 全局池。
- **空链下方常驻说明**：「未配置时等同于 `direct_connect`（裸 TCP 直连）」。空和显式直连行为一致，不说清楚会让人以为没生效。
- **「+ 新建节点…」就地展开**三个字段（名称 / URL / 拨号超时），保存调 `POST /api/proxies`，成功即把新 id 追加到链尾并刷新下拉，全程不离开这一行。
- 保存调 `PATCH /api/upstreams/:id`，**body 只带 `proxyFallbackList` 一个字段**。安全的：PATCH 其余字段全是 `body.x === undefined ? existing.x : ...` 的形状；唯独 `config` 走浅合并 + `'***'` 哨兵，不传就完全不碰。

### upstream 行上的入口

`UpstreamRow` 加「代理」按钮，**仅 admin 可见，不受 `locked` 约束**（这就是「半只读」的落点）。所有行都显示，不区分是否自己拥有。点开在行下方就地展开 `ProxyChainEditor`。

`UpstreamFormModal`（956 行）**一行不改**，proxy 不作为表单 section。

---

## 不做

- **colo 白名单** — schema 字段保留，UI 不暴露，写入不带。只对 CFW 部署有意义，而当前 CFW + Docker 双部署会让条件渲染需要后端暴露 runtime 类型。
- **`proxies` 加 `owner_id`** — 普通用户不参与代理配置。
- **链上的冷却徽标** — backoff 只在 Proxies tab 里看。
- **历史 `unit_price` 回填** — 与本设计无关，另轮处理。

---

## 测试与验证

1. `bun test` 全绿。新增覆盖：
   - `control-plane/proxies` 路由的 CRUD + 非 admin 403 + 删除被引用节点回 409
   - upstream POST/PATCH 往返 `proxyFallbackList`，含去重和 colo 大写化
2. dashboard `typecheck` + `bun run build`（build 有 CSS < 30,000 bytes 就抛错的守卫）
3. **本地 Docker 验证**：起容器 → `/dashboard` → Proxies tab 建一个节点 → 某个 upstream 挂上链 → 发请求确认走代理 → 故意配一个坏节点确认退到直连且 backoff 面板显示错误
4. Docker 验证通过后再谈 CFW / SSH 部署。CFW 部署必须在 `vnext/apps/platform-cloudflare` 目录下执行。

全程留在 `vNext` 分支，不合并 main。
