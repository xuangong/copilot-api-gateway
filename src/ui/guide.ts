// LLM Relay user guide page - for non-technical users
import { Layout } from "./layout"

export function GuidePage(): string {
  return Layout({
    title: "LLM Relay 使用指南",
    children: `
      <div class="min-h-screen">
        <!-- Header -->
        <div class="border-b border-themed sticky top-0 z-50" style="background: var(--surface-900);">
          <div class="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-accent-violet/20 flex items-center justify-center">
                <svg class="w-5 h-5 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                  <path d="M2 17l10 5 10-5"/>
                  <path d="M2 12l10 5 10-5"/>
                </svg>
              </div>
              <h1 class="text-lg font-semibold text-themed">LLM Relay 使用指南</h1>
            </div>
            <button onclick="toggleTheme()" class="theme-toggle w-8 h-8">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="5"/>
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- Content -->
        <div class="max-w-3xl mx-auto px-6 py-10 space-y-14">

          <!-- Intro -->
          <section class="animate-in">
            <div class="glass-card p-8 text-center">
              <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent-violet/10 glow-border mb-4">
                <svg class="w-8 h-8 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                  <path d="M2 17l10 5 10-5"/>
                  <path d="M2 12l10 5 10-5"/>
                </svg>
              </div>
              <h2 class="text-2xl font-bold text-themed mb-3">什么是 LLM Relay？</h2>
              <p class="text-themed-secondary leading-relaxed max-w-lg mx-auto">
                LLM Relay 是一款桌面应用，让你轻松连接和管理 Copilot API Gateway。
                它会自动帮你配置 Claude Code、Codex CLI、Gemini CLI 等 AI 工具，
                让它们通过你的 Gateway 来调用模型，无需手动修改任何配置文件。
              </p>
            </div>
          </section>

          <!-- Step 1: Download & Install -->
          <section class="animate-in delay-1">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-8 h-8 rounded-full bg-accent-violet flex items-center justify-center text-white font-bold text-sm shrink-0">1</div>
              <h2 class="text-xl font-bold text-themed">下载安装</h2>
            </div>

            <div class="glass-card p-6 space-y-4">
              <div class="space-y-3">
                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium">下载 DMG 安装包</p>
                    <p class="text-sm text-themed-secondary mt-1">
                      前往 <a href="https://github.com/xuangong/llm-relay/releases/latest" target="_blank" class="text-accent-violet hover:underline">GitHub Releases</a> 页面，
                      下载最新的 <code class="text-xs bg-surface-700 px-1.5 py-0.5 rounded font-mono">LLM Relay_x.x.x_aarch64.dmg</code> 文件。
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8M12 8v8"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium">安装应用</p>
                    <p class="text-sm text-themed-secondary mt-1">
                      双击打开 DMG，将 LLM Relay 图标拖到 Applications 文件夹中，然后从启动台打开应用。
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium">首次打开提示</p>
                    <p class="text-sm text-themed-secondary mt-1">
                      macOS 可能会提示"无法验证开发者"。请前往 <strong>系统设置 → 隐私与安全性</strong>，
                      找到 LLM Relay 并点击"仍要打开"。
                    </p>
                  </div>
                </div>
              </div>

              <!-- Mock screenshot -->
              <div class="rounded-xl border border-themed overflow-hidden" style="background: var(--surface-800);">
                <div class="flex items-center gap-1.5 px-4 py-2.5 border-b border-themed">
                  <div class="w-2.5 h-2.5 rounded-full bg-red-500/60"></div>
                  <div class="w-2.5 h-2.5 rounded-full bg-yellow-500/60"></div>
                  <div class="w-2.5 h-2.5 rounded-full bg-green-500/60"></div>
                  <span class="text-[10px] text-themed-dim ml-2 font-mono">LLM Relay</span>
                </div>
                <div class="p-8 flex flex-col items-center gap-4">
                  <div class="w-12 h-12 rounded-2xl bg-accent-violet/20 flex items-center justify-center">
                    <svg class="w-6 h-6 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                      <path d="M2 17l10 5 10-5"/>
                      <path d="M2 12l10 5 10-5"/>
                    </svg>
                  </div>
                  <p class="text-themed-dim text-xs">首次打开 — 空白界面，点击右上角 + 添加 Gateway</p>
                  <div class="w-48 h-8 rounded-lg border border-dashed border-themed flex items-center justify-center">
                    <span class="text-[10px] text-accent-violet font-medium">+ Add Gateway</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- Step 2: Add Gateway -->
          <section class="animate-in delay-2">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-8 h-8 rounded-full bg-accent-cyan flex items-center justify-center text-white font-bold text-sm shrink-0">2</div>
              <h2 class="text-xl font-bold text-themed">添加 Gateway</h2>
            </div>

            <div class="glass-card p-6 space-y-5">
              <p class="text-themed-secondary text-sm">
                点击应用右上角的 <strong class="text-themed">+ Add Gateway</strong> 按钮，开始连接你的 Gateway 服务。
              </p>

              <!-- Sub-step 2a -->
              <div class="space-y-4">
                <div class="flex items-center gap-2.5">
                  <span class="text-xs font-bold text-accent-violet bg-accent-violet/10 rounded-full px-2.5 py-1">2a</span>
                  <span class="text-themed font-medium text-sm">输入 Gateway 地址</span>
                </div>
                <p class="text-themed-secondary text-sm pl-9">
                  在弹窗中输入你的 Gateway URL（例如 <code class="text-xs bg-surface-700 px-1.5 py-0.5 rounded font-mono">https://token.xianliao.de5.net</code>），然后点击 <strong class="text-themed">Sign In</strong>。
                </p>

                <!-- Mock: URL input -->
                <div class="rounded-xl border border-themed p-5 ml-9" style="background: var(--surface-800);">
                  <div class="space-y-3">
                    <div class="text-xs text-themed-dim font-medium uppercase tracking-wider">Gateway URL</div>
                    <div class="rounded-lg border border-themed px-3 py-2.5 font-mono text-xs text-themed-secondary" style="background: var(--input-bg);">
                      https://token.xianliao.de5.net
                    </div>
                    <div class="flex justify-end gap-2">
                      <div class="px-3 py-1.5 rounded-lg text-xs text-themed-dim border border-themed">Cancel</div>
                      <div class="px-3 py-1.5 rounded-lg text-xs text-white bg-accent-violet font-medium">Sign In</div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Sub-step 2b -->
              <div class="space-y-4">
                <div class="flex items-center gap-2.5">
                  <span class="text-xs font-bold text-accent-cyan bg-accent-cyan/10 rounded-full px-2.5 py-1">2b</span>
                  <span class="text-themed font-medium text-sm">输入验证码</span>
                </div>
                <p class="text-themed-secondary text-sm pl-9">
                  应用会显示一个 <strong class="text-themed">8 位验证码</strong>（如 <code class="text-xs bg-surface-700 px-1.5 py-0.5 rounded font-mono">A1B2-C3D4</code>），
                  同时自动打开浏览器跳转到 Gateway 登录页面。验证码已自动复制到剪贴板。
                </p>
                <div class="text-themed-secondary text-sm pl-9 space-y-2">
                  <p>在浏览器中：</p>
                  <ol class="list-decimal list-inside space-y-1 text-themed-secondary text-sm">
                    <li>如果还没有登录，先用你的账号<strong class="text-themed">登录 Gateway</strong></li>
                    <li>在验证码输入框中<strong class="text-themed">粘贴或输入验证码</strong></li>
                    <li>点击 <strong class="text-themed">Verify</strong> 确认授权</li>
                  </ol>
                </div>

                <!-- Mock: Device code display -->
                <div class="rounded-xl border border-themed p-5 ml-9" style="background: var(--surface-800);">
                  <div class="flex flex-col items-center gap-3">
                    <div class="text-2xl font-bold font-mono tracking-[0.15em] text-themed px-4 py-2 rounded-lg" style="background: var(--surface-700);">
                      A1B2-C3D4
                    </div>
                    <p class="text-[11px] text-themed-dim">验证码已复制到剪贴板，请在浏览器中输入</p>
                    <div class="flex items-center gap-2 text-themed-dim text-xs">
                      <svg class="animate-spin h-3.5 w-3.5 text-accent-violet" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                      </svg>
                      等待授权中...
                    </div>
                  </div>
                </div>
              </div>

              <!-- Sub-step 2c -->
              <div class="space-y-4">
                <div class="flex items-center gap-2.5">
                  <span class="text-xs font-bold text-accent-teal bg-accent-teal/10 rounded-full px-2.5 py-1">2c</span>
                  <span class="text-themed font-medium text-sm">选择 API Key</span>
                </div>
                <p class="text-themed-secondary text-sm pl-9">
                  授权成功后，应用会自动加载你账号下的 API Key 列表。选择一个要使用的 Key，然后点击 <strong class="text-themed">Add Gateway</strong>。
                </p>
                <p class="text-themed-secondary text-sm pl-9">
                  这个 Key 将用于所有 AI 模型请求的身份验证。如果你只有一个 Key，会自动选中。
                </p>

                <!-- Mock: Key selection -->
                <div class="rounded-xl border border-themed p-5 ml-9" style="background: var(--surface-800);">
                  <div class="space-y-3">
                    <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs" style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2);">
                      <svg class="w-3.5 h-3.5 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      <span class="text-accent-teal">已登录为 <strong>Your Name</strong></span>
                    </div>
                    <div class="text-[10px] text-themed-dim font-medium uppercase tracking-wider">选择 API Key</div>
                    <div class="rounded-lg border px-3 py-2.5 flex items-center gap-3" style="border-color: rgba(139, 92, 246, 0.4); background: rgba(139, 92, 246, 0.05);">
                      <div class="w-7 h-7 rounded-md flex items-center justify-center" style="background: rgba(139, 92, 246, 0.1);">
                        <svg class="w-3.5 h-3.5 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 1 0 1.4l-1 1M10 12.5l-6.3 6.3a1 1 0 0 0 0 1.4l.8.8a1 1 0 0 0 1.4 0l6.3-6.3"/><circle cx="16" cy="8" r="5"/></svg>
                      </div>
                      <div class="flex-1">
                        <div class="text-xs font-medium text-accent-violet">My API Key</div>
                        <div class="text-[10px] font-mono text-themed-dim">ghu_abcd…ef12</div>
                      </div>
                      <svg class="w-3.5 h-3.5 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>
                    <div class="flex justify-end gap-2 pt-1">
                      <div class="px-3 py-1.5 rounded-lg text-xs text-themed-dim border border-themed">Cancel</div>
                      <div class="px-3 py-1.5 rounded-lg text-xs text-white bg-accent-violet font-medium">Add Gateway</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- Step 3: Use -->
          <section class="animate-in delay-3">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-8 h-8 rounded-full bg-accent-teal flex items-center justify-center text-white font-bold text-sm shrink-0">3</div>
              <h2 class="text-xl font-bold text-themed">启用 Gateway</h2>
            </div>

            <div class="glass-card p-6 space-y-4">
              <p class="text-themed-secondary text-sm">
                Gateway 添加成功后会出现在主界面的列表中。点击展开卡片，然后：
              </p>

              <div class="space-y-3 pl-1">
                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium">点击铅笔图标进入编辑模式</p>
                    <p class="text-sm text-themed-secondary mt-1">
                      可以修改名称、URL，选择不同的 API Key，以及配置各 AI 工具使用的模型。
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium">选择模型，点击 Done</p>
                    <p class="text-sm text-themed-secondary mt-1">
                      应用会自动列出 Gateway 上可用的模型。为 Claude、Claude Small、Codex、Gemini 各选一个模型，
                      然后点击 <strong class="text-themed">Done</strong>。
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium">配置自动生效</p>
                    <p class="text-sm text-themed-secondary mt-1">
                      LLM Relay 会自动修改你电脑上的 Claude Code、Codex CLI、Gemini CLI 的配置文件，
                      让它们通过你选中的 Gateway 和 Key 来发送请求。<strong class="text-themed">无需手动操作。</strong>
                    </p>
                  </div>
                </div>
              </div>

              <!-- Mock: Gateway card -->
              <div class="rounded-xl border border-themed overflow-hidden" style="background: var(--surface-800);">
                <div class="px-4 py-3 flex items-center gap-3 border-b border-themed">
                  <div class="w-2.5 h-2.5 rounded-full bg-green-500 relative">
                    <span class="absolute inset-0 rounded-full bg-green-500 animate-ping opacity-40"></span>
                  </div>
                  <span class="text-sm font-medium text-themed">My Gateway</span>
                  <span class="text-[9px] font-bold uppercase tracking-wider bg-accent-violet text-white px-1.5 py-0.5 rounded">IN USE</span>
                  <span class="text-[10px] text-themed-dim font-mono ml-auto">125ms · 48m</span>
                </div>
                <div class="px-4 py-3 space-y-2">
                  <div class="text-[10px] text-themed-dim font-medium uppercase tracking-wider">Models</div>
                  <div class="grid grid-cols-2 gap-2">
                    <div class="rounded-lg border border-themed px-2.5 py-1.5">
                      <div class="text-[10px] text-themed-dim">Claude</div>
                      <div class="text-[11px] font-mono text-themed">claude-sonnet-4-...</div>
                    </div>
                    <div class="rounded-lg border border-themed px-2.5 py-1.5">
                      <div class="text-[10px] text-themed-dim">Codex</div>
                      <div class="text-[11px] font-mono text-themed">o4-mini</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- Step 4: Health & Traffic -->
          <section class="animate-in delay-4">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-8 h-8 rounded-full bg-accent-amber flex items-center justify-center text-white font-bold text-sm shrink-0">4</div>
              <h2 class="text-xl font-bold text-themed">监控与自动切换</h2>
            </div>

            <div class="glass-card p-6 space-y-4">
              <div class="space-y-3">
                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium">健康监控</p>
                    <p class="text-sm text-themed-secondary mt-1">
                      应用每 60 秒检查一次 Gateway 的健康状况。绿色圆点表示正常，红色表示离线。
                      卡片中的柱状图显示历史延迟和可用性。
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 7h12l-4 8H4l4-8z"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium">流量监控</p>
                    <p class="text-sm text-themed-secondary mt-1">
                      当前使用中的 Gateway 卡片下方会显示实时流量点：绿色 = 正常，红色 = 错误，黄色 = 频率限制。
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3l5 5-5 5"/><path d="M21 8H9"/><path d="M8 21l-5-5 5-5"/><path d="M3 16h12"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium">自动切换（可选）</p>
                    <p class="text-sm text-themed-secondary mt-1">
                      如果你添加了多个 Gateway，可以在设置中开启"Auto Switch"。
                      当前 Gateway 出现故障时，应用会自动切换到其他健康的 Gateway，保证 AI 工具不中断。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- FAQ -->
          <section class="animate-in delay-5">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-8 h-8 rounded-full bg-surface-600 flex items-center justify-center text-themed font-bold text-sm shrink-0">?</div>
              <h2 class="text-xl font-bold text-themed">常见问题</h2>
            </div>

            <div class="space-y-3">
              <div class="glass-card p-5">
                <h3 class="text-sm font-semibold text-themed mb-2">应用关闭后 AI 工具还能用吗？</h3>
                <p class="text-sm text-themed-secondary">
                  可以。LLM Relay 运行一个本地代理（127.0.0.1:18080），AI 工具通过这个代理转发请求。
                  如果应用退出，代理也会停止，AI 工具会无法连接。建议保持应用在后台运行（关闭窗口不会退出，应用会最小化到菜单栏）。
                </p>
              </div>

              <div class="glass-card p-5">
                <h3 class="text-sm font-semibold text-themed mb-2">我可以切换不同的 API Key 吗？</h3>
                <p class="text-sm text-themed-secondary">
                  可以。点击 Gateway 卡片的编辑按钮（铅笔图标），在 API Key 列表中选择另一个 Key，然后点击 Done。
                </p>
              </div>

              <div class="glass-card p-5">
                <h3 class="text-sm font-semibold text-themed mb-2">支持哪些 AI 工具？</h3>
                <p class="text-sm text-themed-secondary">
                  目前支持：<strong class="text-themed">Claude Code</strong>（Anthropic）、
                  <strong class="text-themed">Codex CLI</strong>（OpenAI）、
                  <strong class="text-themed">Gemini CLI</strong>（Google）。
                  应用会自动配置这三个工具的配置文件。
                </p>
              </div>

              <div class="glass-card p-5">
                <h3 class="text-sm font-semibold text-themed mb-2">如何获取 Gateway 账号？</h3>
                <p class="text-sm text-themed-secondary">
                  请联系你的 Gateway 管理员获取邀请码或登录凭据。如果你是管理员，请在 Gateway Dashboard 中创建用户。
                </p>
              </div>
            </div>
          </section>

          <!-- Footer -->
          <div class="text-center py-8 text-themed-dim text-xs">
            <p>LLM Relay — 轻松管理你的 AI Gateway</p>
          </div>
        </div>
      </div>
    `,
  })
}
