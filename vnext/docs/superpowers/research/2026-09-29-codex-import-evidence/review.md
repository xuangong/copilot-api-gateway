### Spec Compliance

- ✅ 冻结候选的任务内实现符合要求；未发现应阻塞该包的缺失、越界或错误语义。`vnext/packages/gateway/src/control-plane/upstreams/codex-credentials-routes.ts:178`、`:187`、`:248` 分别实现仅 session 的 preview/import/refresh；`:43` 在 JSON materialization 前按实际流字节限制 1 MiB；`:170` 和 `:224` 将重导入绑定到原始账号、owner、incarnation 与 credential revision，并使用专用 CAS；`:238` 初次导入使用 createIfAbsent。
- ✅ Dashboard 接入原创建/编辑入口，凭据状态和 renewable refresh 入口来自安全 DTO：`vnext/apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx:722`、`vnext/apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx:134`。`CodexImportPanel.tsx:30`、`:75`、`:97`、`:113` 将异步结果绑定到 draft ticket，并在成功、目标变更和卸载时清除文档。
- ⚠️ 此 diff 未修改 parser 原始行计数规则、六 provider DTO allowlist、generic PATCH 凭据禁止规则及 repo 的原子 generation 实现；这些依赖已接受的基线，不能把本次 diff 审查当作对所有基线行为的重新证明。新路由显式复用 preview/import parser、serializeUpstream 与 replaceCredentials。完整 CI、实际 workerd/D1、HTTP 和 Chromium/SQLite 验收仍归 root；本次不宣称 live provider 验证。

### Strengths

- `vnext/packages/gateway/src/control-plane/upstreams/codex-credentials-routes.ts:224` 仅替换 config/state，避免用旧快照重存并发元数据；重试始终重新校验授权目标，最多八次。
- `vnext/packages/gateway/src/control-plane/upstreams/codex-credentials-routes.ts:262` 捕获已授权行的代理策略；`:266` 将实际 Request/lifetime cancellation 交给 authoritative lifecycle，mint 前再次校验 credential revision，结束后再次读取公共结果。
- `vnext/packages/gateway/tests/control-plane-codex-import.sqlite.test.ts:350`、`:382` 使用真实 SQLite 验证有界 contention 与取消后的迟到 OAuth 响应；并发插桩仍调用实际 repo 操作，没有伪造 SQL 成功。
- `vnext/apps/dashboard/src/tabs/upstreams/codex-import-draft.test.ts:4` 覆盖 document/target 变化淘汰迟到结果；`CodexImportPanel.tsx:97` 重导入请求只提交目标与所选文档，不提交新建表单默认元数据。

### Issues

- Critical：无。
- Important：无。
- Minor：无需要单独提出的确定问题。

### Assessment

**Task quality:** Approved。

- 定点风险核查：显式 refresh 是否可能绕过 revision/owner/incarnation 或取消边界。读取未改动的 `vnext/packages/provider-codex/src/access-token.ts:103`–`:214`；有 signal 的 ensure 路径自行捕获 snapshot、强制 mint、按 credential effect 写回并做 authoritative reread，与路由 guard 一致。
- 定点风险核查：无效代理是否静默降级 direct，以及外部 ID 是否泄露存在性。读取未改动的 `vnext/packages/gateway/src/control-plane/upstreams/proxy-resolution.ts` 和 `vnext/packages/gateway/src/control-plane/shared/ownership.ts`；override 对无效代理抛错，只有空链返回 undefined，loadOwned 保持 foreign/missing 等价。
- 已按顺序单次阅读完整 diff；之后仅从 patch 提取引用行号，未重读产品文件。未执行测试、Git mutation 或产品修改；测试通过信息来自 implementer report，尚未作为独立重跑结果背书。
