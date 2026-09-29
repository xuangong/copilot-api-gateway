### Spec Compliance

- ❌ Issues found: C05 的 Fast catalog/dispatch/output/pricing 主链满足任务，但替换 selector 时意外移除了 count-tokens 既有 ordinary context/effort 解析；见 Important 1。当前全量 CI 另有五处过时 raw-pin 断言，见 Important 2。
- ✅ raw pin、已知 Fast lane、endpoint 限制、Messages strict error / Responses fallback 的主干分别见 `vnext/packages/provider-copilot/src/variants.ts:437-495`、`vnext/packages/provider-copilot/src/interceptors/shared/with-variant-and-beta-filtering.ts:100-133`。
- ⚠️ 本次只验证实现与 fake catalog；没有 live availability 或当前外部价格结论。根代理报告 frozen runtime PASS；完整 CI 当前失败，不能视为最终验收通过。protected integration 尚未执行，属于根代理后续 gate。

### Strengths

- `vnext/packages/provider-copilot/src/provider.ts:180-219` 使用每次 fetch 的 closure 和 frozen selection，仅成功 response 暴露 execution；没有新增 provider-wide 执行状态，retry 重用已经准备好的请求。
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts:314` 保留原始 sourceProtocol；`shared/traverse-translation.ts:79-87,152,201-207` 保留请求 hint 并在翻译回源协议后回显实际 tier，避免将请求 priority 当作执行结果。
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/execution-tier.ts:7-25` 不根据请求伪造 tier，不修改 token counters；`messages/events/reassemble.ts:48-49` 保留 JSON 的 speed/service_tier。
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts:52-59` 冻结 exact pricing identity。针对“provider 回传 base model 覆盖 Fast billing”风险，聚焦核查既有 `shared/respond-telemetry.ts:104-105,119-121`：执行 key 已锁定时忽略响应模型名称。
- `vnext/packages/provider-copilot/src/variants.ts:499-518` listing 保留 raw rows、两种显示标签和 endpoint lane；`gateway/src/data-plane/codex/synthesize.ts:130-140` 仅采用所选 upstream endpoint 已知事实。

### Issues

#### Critical (Must Fix)

- 无。

#### Important (Should Fix)

1. **count-tokens ordinary variant regression** — `vnext/packages/provider-copilot/src/variants.ts:478` 与 `src/interceptors/shared/with-variant-and-beta-filtering.ts:107`。新 selector 在 `messages_count_tokens` 上立即返回输入 modelId，之前同一路径会调用 `resolveCopilotRawModel`。因此 base + `-1m-internal` catalog 中，带 context1m 的 count-tokens 现在请求 base，而实际 Messages 推理仍选择 1m 变体；effort-only 和非原始 composite ID 的 ordinary 解析也同样被跳过。“不新增 Fast lane”不应移除原有 ordinary variant resolution。建议为 count-tokens 保留排除 Fast 后的 ordinary resolver，并保持无 tier metadata；添加 provider-level regression 检查实际 wire model 和 context beta stripping。
   - 针对此风险只执行一次 focused Bun repro：catalog 为 `claude-opus-4.8` + `claude-opus-4.8-1m-internal`、`context1m:true`。旧 resolver 输出 `claude-opus-4.8-1m-internal`；新 selector 输出 `{modelKey:"claude-opus-4.8"}`。未重跑整套测试。

2. **更新与 raw-pin 新契约冲突的五处测试断言** — `vnext/packages/gateway/tests/messages.e2e.test.ts:181,201`；`vnext/packages/gateway/tests/gemini.e2e.test.ts:178,196,229`。根代理全 CI 的五个 failure 均期望已去日期的 `claude-3-5-sonnet`，实际发送 catalog 精确 raw ID `claude-3-5-sonnet-20241022`。聚焦检查 Gemini catalog fixture、mapping destination 与 Messages 同名 fixture 后，判定新行为符合 brief 的 raw pin 要求，**不是应回退的产品行为**。将断言改为 fixture `MODEL_ID`，保留 captured wire model 检查，再由根代理完成验收。证据 `/tmp/vnext-c05-clean-ci.log:830-855,2211-2251`。

#### Minor (Nice to Have)

- 没有新增可阻断的告警意义。继承的 35 条全 CI lint warnings 与 `traverse-translation.ts:57` SourceFrame warning 按根代理提供的 baseline 记录，未发现该任务增加 suppression 或新的相同问题。

### Assessment

**Task quality:** Needs fixes

**Reasoning:** Fast lane 的每调用身份、协议来源、实际 tier 回显与 exact raw pricing 连接合理；需要修复 count-tokens ordinary resolver 回归并同步五处 raw-pin 测试期待，再完成根代理 gate。

**Review checks:** 读 task brief/report/patch；首次合并输出发生截断，随后分段补读缺失 patch 内容，没有重新抓取 git diff。hunk 截断处仅补读 variants helper 与 interceptor 的 composite 预处理。具名风险检查为 count-tokens resolver、sourceProtocol 的 Messages/chat call sites、exact pricing identity accumulator、根代理指出的五处 CI raw-pin 失败。读取 `/tmp/c05-final-tests.log` 确认 writer 报告的 217 pass / 0 fail / 709 expectations / 26 files；未重复整套或根代理 CI，未修改产品、测试、git 状态，未调用外部 provider。

**Root evidence update:** 根代理在本报告完成时补充真实 Bun gateway → CopilotProvider → loopback count-tokens context probe，独立确认同一回归，证据 `/tmp/vnext-c05-counttokens-red-runtime.out`；17-case 脚本已包含 context/effort。此项属于根代理报告的 runtime 证据，本 reviewer 未重复执行。
