// Getting-started guide — takes a brand-new user from invite code to a working client.
// Two audiences share this page: self-hosted users who link their own GitHub Copilot,
// and shared-key users who were handed a key and need neither GitHub nor an upstream.
import { Layout } from "./layout"

const GATEWAY_URL = "https://token.xianliao.de5.net"

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function codeBlock(text: string): string {
  const escaped = escapeHtml(text)
  return `
    <div class="rounded-xl border border-themed overflow-hidden" style="background: var(--surface-800);">
      <div class="flex items-start gap-3 px-4 py-3">
        <pre class="flex-1 font-mono text-xs text-themed-secondary whitespace-pre-wrap break-all m-0">${escaped}</pre>
        <button type="button"
                class="shrink-0 text-[10px] px-2 py-1 rounded-md border border-themed text-themed-dim hover:text-accent-violet"
                data-copy="${escaped}"
                onclick="navigator.clipboard.writeText(this.dataset.copy); this.textContent='OK'; setTimeout(()=>{this.textContent='Copy'},1200)">Copy</button>
      </div>
    </div>`
}

function stepHeader(n: string, color: string, key: string, badgeKey?: string): string {
  return `
    <div class="flex items-center gap-3 mb-5 flex-wrap">
      <div class="w-8 h-8 rounded-full ${color} flex items-center justify-center text-white font-bold text-sm shrink-0">${n}</div>
      <h2 class="text-xl font-bold text-themed" x-text="t('${key}')"></h2>
      ${
        badgeKey
          ? `<span class="text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-full bg-accent-amber/15 text-accent-amber" x-text="t('${badgeKey}')"></span>`
          : ""
      }
    </div>`
}

function bullet(iconPath: string, iconColor: string, titleKey: string, descKey: string): string {
  return `
    <div class="flex items-start gap-3">
      <div class="w-6 h-6 rounded-md bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
        <svg class="w-3.5 h-3.5 ${iconColor}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">${iconPath}</svg>
      </div>
      <div>
        <p class="text-themed font-medium" x-text="t('${titleKey}')"></p>
        <p class="text-sm text-themed-secondary mt-1" x-html="thtml('${descKey}')"></p>
      </div>
    </div>`
}

const ICON_CHECK = `<polyline points="20 6 9 17 4 12"/>`
const ICON_KEY = `<path d="m15.5 7.5 2.3 2.3a1 1 0 0 1 0 1.4l-1 1M10 12.5l-6.3 6.3a1 1 0 0 0 0 1.4l.8.8a1 1 0 0 0 1.4 0l6.3-6.3"/><circle cx="16" cy="8" r="5"/>`
const ICON_DOWNLOAD = `<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>`
const ICON_TERMINAL = `<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>`
const ICON_MAIL = `<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>`
const ICON_LINK = `<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>`
const ICON_CHART = `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`
const ICON_EDIT = `<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>`

export function GuidePage(): string {
  return Layout({
    title: "Getting Started",
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
              <p class="text-themed-dim text-sm leading-relaxed max-w-lg mx-auto mt-3" x-text="t('guide.introDesc2')"></p>
            </div>
          </section>

          <!-- Which kind of account -->
          <section class="animate-in delay-1">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-8 h-8 rounded-full bg-surface-600 flex items-center justify-center text-themed font-bold text-sm shrink-0">?</div>
              <h2 class="text-xl font-bold text-themed" x-text="t('guide.pathTitle')"></h2>
            </div>
            <div class="space-y-4">
              <p class="text-themed-secondary text-sm" x-text="t('guide.pathDesc')"></p>
              <div class="grid md:grid-cols-2 gap-4">
                <div class="glass-card p-5 space-y-2" style="border-color: rgba(139, 92, 246, 0.35);">
                  <div class="flex items-center gap-2">
                    <svg class="w-4 h-4 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">${ICON_LINK}</svg>
                    <h3 class="text-sm font-semibold text-themed" x-text="t('guide.pathATitle')"></h3>
                  </div>
                  <p class="text-sm text-themed-secondary" x-text="t('guide.pathADesc')"></p>
                </div>
                <div class="glass-card p-5 space-y-2" style="border-color: rgba(16, 185, 129, 0.35);">
                  <div class="flex items-center gap-2">
                    <svg class="w-4 h-4 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">${ICON_KEY}</svg>
                    <h3 class="text-sm font-semibold text-themed" x-text="t('guide.pathBTitle')"></h3>
                  </div>
                  <p class="text-sm text-themed-secondary" x-html="thtml('guide.pathBDesc')"></p>
                </div>
              </div>
              <p class="text-themed-dim text-xs" x-text="t('guide.pathHint')"></p>
            </div>
          </section>

          <!-- Step 1: account -->
          <section class="animate-in delay-2">
            ${stepHeader("1", "bg-accent-violet", "guide.s1Title")}
            <div class="glass-card p-6 space-y-4">
              <p class="text-themed-secondary text-sm" x-text="t('guide.s1Desc')"></p>
              <div class="space-y-3">
                ${bullet(ICON_MAIL, "text-accent-violet", "guide.s1aTitle", "guide.s1aDesc")}
                ${bullet(ICON_EDIT, "text-accent-cyan", "guide.s1bTitle", "guide.s1bDesc")}
                ${bullet(ICON_CHECK, "text-accent-teal", "guide.s1cTitle", "guide.s1cDesc")}
                ${bullet(ICON_CHART, "text-accent-amber", "guide.s1dTitle", "guide.s1dDesc")}
              </div>
            </div>
          </section>

          <!-- Step 2: GitHub upstream -->
          <section class="animate-in delay-3">
            ${stepHeader("2", "bg-accent-cyan", "guide.s2Title", "guide.s2Badge")}
            <div class="glass-card p-6 space-y-4">
              <div class="rounded-xl px-4 py-3 text-sm" style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25);">
                <span class="text-accent-teal" x-text="t('guide.s2Skip')"></span>
              </div>
              <p class="text-themed-secondary text-sm" x-html="thtml('guide.s2Desc')"></p>
              <div class="space-y-3">
                ${bullet(ICON_LINK, "text-accent-violet", "guide.s2aTitle", "guide.s2aDesc")}
                ${bullet(ICON_TERMINAL, "text-accent-cyan", "guide.s2bTitle", "guide.s2bDesc")}
                ${bullet(ICON_CHECK, "text-accent-teal", "guide.s2cTitle", "guide.s2cDesc")}
              </div>

              <!-- Mock: device code -->
              <div class="rounded-xl border border-themed p-5" style="background: var(--surface-800);">
                <div class="flex flex-col items-center gap-3">
                  <div class="text-[10px] text-themed-dim font-medium uppercase tracking-wider" x-text="t('guide.s2MockCode')"></div>
                  <div class="text-2xl font-bold font-mono tracking-[0.15em] text-themed px-4 py-2 rounded-lg" style="background: var(--surface-700);">
                    A1B2-C3D4
                  </div>
                  <div class="flex items-center gap-2 text-themed-dim text-xs">
                    <svg class="animate-spin h-3.5 w-3.5 text-accent-violet" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                    </svg>
                    <span x-text="t('guide.s2MockWaiting')"></span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- Step 3: API key -->
          <section class="animate-in delay-4">
            ${stepHeader("3", "bg-accent-teal", "guide.s3Title")}
            <div class="glass-card p-6 space-y-4">
              <p class="text-themed-secondary text-sm" x-html="thtml('guide.s3Desc')"></p>
              <div class="space-y-3">
                ${bullet(ICON_KEY, "text-accent-violet", "guide.s3aTitle", "guide.s3aDesc")}
                ${bullet(ICON_CHECK, "text-accent-teal", "guide.s3bTitle", "guide.s3bDesc")}
                ${bullet(ICON_EDIT, "text-accent-amber", "guide.s3cTitle", "guide.s3cDesc")}
              </div>
            </div>
          </section>

          <!-- Step 4: configure a client -->
          <section class="animate-in delay-5">
            ${stepHeader("4", "bg-accent-amber", "guide.s4Title")}
            <div class="glass-card p-6 space-y-4">
              <p class="text-themed-secondary text-sm" x-text="t('guide.s4Desc')"></p>
              <div class="space-y-3">
                ${bullet(ICON_LINK, "text-accent-violet", "guide.s4aTitle", "guide.s4aDesc")}
                ${bullet(ICON_EDIT, "text-accent-cyan", "guide.s4bTitle", "guide.s4bDesc")}
                ${bullet(ICON_CHECK, "text-accent-teal", "guide.s4cTitle", "guide.s4cDesc")}
              </div>

              <div class="grid md:grid-cols-3 gap-3 pt-1">
                <div class="rounded-xl border border-themed p-4 space-y-1.5" style="background: var(--surface-800);">
                  <div class="text-xs font-semibold text-accent-violet" x-text="t('guide.s4ClaudeTitle')"></div>
                  <p class="text-[11px] text-themed-secondary leading-relaxed" x-text="t('guide.s4ClaudeDesc')"></p>
                </div>
                <div class="rounded-xl border border-themed p-4 space-y-1.5" style="background: var(--surface-800);">
                  <div class="text-xs font-semibold text-accent-cyan" x-text="t('guide.s4CodexTitle')"></div>
                  <p class="text-[11px] text-themed-secondary leading-relaxed" x-text="t('guide.s4CodexDesc')"></p>
                </div>
                <div class="rounded-xl border border-themed p-4 space-y-1.5" style="background: var(--surface-800);">
                  <div class="text-xs font-semibold text-accent-teal" x-text="t('guide.s4GeminiTitle')"></div>
                  <p class="text-[11px] text-themed-secondary leading-relaxed" x-text="t('guide.s4GeminiDesc')"></p>
                </div>
              </div>
            </div>
          </section>

          <!-- Step 5: LLM Relay -->
          <section class="animate-in delay-5">
            ${stepHeader("5", "bg-surface-600", "guide.s5Title", "guide.s5Badge")}
            <div class="glass-card p-6 space-y-4">
              <p class="text-themed-secondary text-sm" x-text="t('guide.s5Desc')"></p>
              <div class="space-y-3">
                ${bullet(ICON_DOWNLOAD, "text-accent-violet", "guide.s5aTitle", "guide.s5aDesc")}
                ${bullet(ICON_CHECK, "text-accent-cyan", "guide.s5bTitle", "guide.s5bDesc")}
              </div>

              <!-- 5c: quarantine -->
              <div class="rounded-xl p-5 space-y-3" style="background: rgba(245, 158, 11, 0.06); border: 1px solid rgba(245, 158, 11, 0.28);">
                <div class="flex items-center gap-2">
                  <svg class="w-4 h-4 text-accent-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">${ICON_TERMINAL}</svg>
                  <h3 class="text-sm font-semibold text-themed" x-text="t('guide.s5cTitle')"></h3>
                </div>
                <p class="text-sm text-themed-secondary" x-text="t('guide.s5cDesc')"></p>
                <ol class="list-decimal list-outside pl-5 space-y-2 text-sm text-themed-secondary">
                  <li x-html="thtml('guide.s5cStep1')"></li>
                  <li x-html="thtml('guide.s5cStep2')"></li>
                </ol>
                ${codeBlock("xattr -cr /Applications/LLM\\ Relay.app")}
                <p class="text-themed-dim text-xs" x-text="t('guide.s5cCmdHint')"></p>
                <ol class="list-decimal list-outside pl-5 space-y-2 text-sm text-themed-secondary" start="3">
                  <li x-html="thtml('guide.s5cStep3')"></li>
                  <li x-html="thtml('guide.s5cStep4')"></li>
                </ol>
              </div>

              <div class="space-y-3">
                ${bullet(ICON_LINK, "text-accent-violet", "guide.s5dTitle", "guide.s5dDesc")}
                ${bullet(ICON_EDIT, "text-accent-cyan", "guide.s5eTitle", "guide.s5eDesc")}
                ${bullet(ICON_CHART, "text-accent-teal", "guide.s5fTitle", "guide.s5fDesc")}
              </div>
            </div>
          </section>

          <!-- Step 6: verify -->
          <section class="animate-in delay-5">
            ${stepHeader("6", "bg-accent-violet", "guide.s6Title")}
            <div class="glass-card p-6 space-y-4">
              <p class="text-themed-secondary text-sm" x-text="t('guide.s6Desc')"></p>
              <div class="space-y-3">
                ${bullet(ICON_TERMINAL, "text-accent-violet", "guide.s6aTitle", "guide.s6aDesc")}
              </div>
              ${codeBlock(`curl -H "Authorization: Bearer YOUR_API_KEY" ${GATEWAY_URL}/v1/models`)}
              <div class="space-y-3">
                ${bullet(ICON_CHECK, "text-accent-teal", "guide.s6bTitle", "guide.s6bDesc")}
                ${bullet(ICON_CHART, "text-accent-amber", "guide.s6cTitle", "guide.s6cDesc")}
              </div>
            </div>
          </section>

          <!-- FAQ -->
          <section class="animate-in delay-5">
            <div class="flex items-center gap-3 mb-5">
              <div class="w-8 h-8 rounded-full bg-surface-600 flex items-center justify-center text-themed font-bold text-sm shrink-0">!</div>
              <h2 class="text-xl font-bold text-themed" x-text="t('guide.faqTitle')"></h2>
            </div>
            <div class="space-y-3">
              ${[1, 2, 3, 4, 5, 6, 7, 8]
                .map(
                  (i) => `
              <div class="glass-card p-5">
                <h3 class="text-sm font-semibold text-themed mb-2" x-text="t('guide.faq${i}Q')"></h3>
                <p class="text-sm text-themed-secondary" x-html="thtml('guide.faq${i}A')"></p>
              </div>`,
                )
                .join("")}
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
