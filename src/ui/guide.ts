// LLM Relay user guide page - for non-technical users
import { Layout } from "./layout"

export function GuidePage(): string {
  return Layout({
    title: "LLM Relay Guide",
    children: `
      <div class="min-h-screen" x-data="{}">
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
              <h1 class="text-lg font-semibold text-themed" x-text="t('guide.title')"></h1>
            </div>
            <div class="flex items-center">
              <button onclick="toggleLang()" class="theme-toggle w-8 h-8 mr-2">
                <span class="text-xs font-semibold" id="__lang_btn"></span>
              </button>
              <script>document.getElementById('__lang_btn').textContent = window.__lang === 'zh' ? 'EN' : '中';</script>
              <button onclick="toggleTheme()" class="theme-toggle w-8 h-8">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="5"/>
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
                </svg>
              </button>
            </div>
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
              <h2 class="text-2xl font-bold text-themed mb-3" x-text="t('guide.introTitle')"></h2>
              <p class="text-themed-secondary leading-relaxed max-w-lg mx-auto" x-text="t('guide.introDesc')"></p>
            </div>
          </section>

          <!-- Step 1: Download & Install -->
          <section class="animate-in delay-1">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-8 h-8 rounded-full bg-accent-violet flex items-center justify-center text-white font-bold text-sm shrink-0">1</div>
              <h2 class="text-xl font-bold text-themed" x-text="t('guide.step1Title')"></h2>
            </div>

            <div class="glass-card p-6 space-y-4">
              <div class="space-y-3">
                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium" x-text="t('guide.step1aTitle')"></p>
                    <p class="text-sm text-themed-secondary mt-1" x-html="thtml('guide.step1aDesc')"></p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8M12 8v8"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium" x-text="t('guide.step1bTitle')"></p>
                    <p class="text-sm text-themed-secondary mt-1" x-text="t('guide.step1bDesc')"></p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium" x-text="t('guide.step1cTitle')"></p>
                    <p class="text-sm text-themed-secondary mt-1" x-html="thtml('guide.step1cDesc')"></p>
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
                  <p class="text-themed-dim text-xs" x-text="t('guide.step1MockDesc')"></p>
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
              <h2 class="text-xl font-bold text-themed" x-text="t('guide.step2Title')"></h2>
            </div>

            <div class="glass-card p-6 space-y-5">
              <p class="text-themed-secondary text-sm" x-html="thtml('guide.step2Desc')"></p>

              <!-- Sub-step 2a -->
              <div class="space-y-4">
                <div class="flex items-center gap-2.5">
                  <span class="text-xs font-bold text-accent-violet bg-accent-violet/10 rounded-full px-2.5 py-1">2a</span>
                  <span class="text-themed font-medium text-sm" x-text="t('guide.step2aTitle')"></span>
                </div>
                <p class="text-themed-secondary text-sm pl-9" x-html="thtml('guide.step2aDesc')"></p>

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
                  <span class="text-themed font-medium text-sm" x-text="t('guide.step2bTitle')"></span>
                </div>
                <p class="text-themed-secondary text-sm pl-9" x-html="thtml('guide.step2bDesc')"></p>
                <div class="text-themed-secondary text-sm pl-9 space-y-2">
                  <p x-text="t('guide.step2bInstructions')"></p>
                  <ol class="list-decimal list-inside space-y-1 text-themed-secondary text-sm">
                    <li x-html="thtml('guide.step2bStep1')"></li>
                    <li x-html="thtml('guide.step2bStep2')"></li>
                    <li x-html="thtml('guide.step2bStep3')"></li>
                  </ol>
                </div>

                <!-- Mock: Device code display -->
                <div class="rounded-xl border border-themed p-5 ml-9" style="background: var(--surface-800);">
                  <div class="flex flex-col items-center gap-3">
                    <div class="text-2xl font-bold font-mono tracking-[0.15em] text-themed px-4 py-2 rounded-lg" style="background: var(--surface-700);">
                      A1B2-C3D4
                    </div>
                    <p class="text-[11px] text-themed-dim" x-text="t('guide.step2bMockHint')"></p>
                    <div class="flex items-center gap-2 text-themed-dim text-xs">
                      <svg class="animate-spin h-3.5 w-3.5 text-accent-violet" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                      </svg>
                      <span x-text="t('guide.step2bMockWaiting')"></span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Sub-step 2c -->
              <div class="space-y-4">
                <div class="flex items-center gap-2.5">
                  <span class="text-xs font-bold text-accent-teal bg-accent-teal/10 rounded-full px-2.5 py-1">2c</span>
                  <span class="text-themed font-medium text-sm" x-text="t('guide.step2cTitle')"></span>
                </div>
                <p class="text-themed-secondary text-sm pl-9" x-html="thtml('guide.step2cDesc')"></p>
                <p class="text-themed-secondary text-sm pl-9" x-text="t('guide.step2cDesc2')"></p>

                <!-- Mock: Key selection -->
                <div class="rounded-xl border border-themed p-5 ml-9" style="background: var(--surface-800);">
                  <div class="space-y-3">
                    <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs" style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2);">
                      <svg class="w-3.5 h-3.5 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      <span class="text-accent-teal" x-html="thtml('guide.step2cMockSignedIn')"></span>
                    </div>
                    <div class="text-[10px] text-themed-dim font-medium uppercase tracking-wider" x-text="t('guide.step2cMockLabel')"></div>
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
              <h2 class="text-xl font-bold text-themed" x-text="t('guide.step3Title')"></h2>
            </div>

            <div class="glass-card p-6 space-y-4">
              <p class="text-themed-secondary text-sm" x-text="t('guide.step3Desc')"></p>

              <div class="space-y-3 pl-1">
                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium" x-text="t('guide.step3aTitle')"></p>
                    <p class="text-sm text-themed-secondary mt-1" x-text="t('guide.step3aDesc')"></p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium" x-text="t('guide.step3bTitle')"></p>
                    <p class="text-sm text-themed-secondary mt-1" x-html="thtml('guide.step3bDesc')"></p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium" x-text="t('guide.step3cTitle')"></p>
                    <p class="text-sm text-themed-secondary mt-1" x-html="thtml('guide.step3cDesc')"></p>
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
              <h2 class="text-xl font-bold text-themed" x-text="t('guide.step4Title')"></h2>
            </div>

            <div class="glass-card p-6 space-y-4">
              <div class="space-y-3">
                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium" x-text="t('guide.step4aTitle')"></p>
                    <p class="text-sm text-themed-secondary mt-1" x-text="t('guide.step4aDesc')"></p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 7h12l-4 8H4l4-8z"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium" x-text="t('guide.step4bTitle')"></p>
                    <p class="text-sm text-themed-secondary mt-1" x-text="t('guide.step4bDesc')"></p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3.5 h-3.5 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3l5 5-5 5"/><path d="M21 8H9"/><path d="M8 21l-5-5 5-5"/><path d="M3 16h12"/></svg>
                  </div>
                  <div>
                    <p class="text-themed font-medium" x-text="t('guide.step4cTitle')"></p>
                    <p class="text-sm text-themed-secondary mt-1" x-text="t('guide.step4cDesc')"></p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- FAQ -->
          <section class="animate-in delay-5">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-8 h-8 rounded-full bg-surface-600 flex items-center justify-center text-themed font-bold text-sm shrink-0">?</div>
              <h2 class="text-xl font-bold text-themed" x-text="t('guide.faqTitle')"></h2>
            </div>

            <div class="space-y-3">
              <div class="glass-card p-5">
                <h3 class="text-sm font-semibold text-themed mb-2" x-text="t('guide.faq1Q')"></h3>
                <p class="text-sm text-themed-secondary" x-text="t('guide.faq1A')"></p>
              </div>

              <div class="glass-card p-5">
                <h3 class="text-sm font-semibold text-themed mb-2" x-text="t('guide.faq2Q')"></h3>
                <p class="text-sm text-themed-secondary" x-text="t('guide.faq2A')"></p>
              </div>

              <div class="glass-card p-5">
                <h3 class="text-sm font-semibold text-themed mb-2" x-text="t('guide.faq3Q')"></h3>
                <p class="text-sm text-themed-secondary" x-html="thtml('guide.faq3A')"></p>
              </div>

              <div class="glass-card p-5">
                <h3 class="text-sm font-semibold text-themed mb-2" x-text="t('guide.faq4Q')"></h3>
                <p class="text-sm text-themed-secondary" x-text="t('guide.faq4A')"></p>
              </div>
            </div>
          </section>

          <!-- Footer -->
          <div class="text-center py-8 text-themed-dim text-xs">
            <p x-text="t('guide.footer')"></p>
          </div>
        </div>
      </div>
    `,
  })
}
