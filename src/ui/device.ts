// Device code verification page - user enters the code shown on their desktop app
import { Layout } from "./layout"

export function DevicePage(): string {
  return Layout({
    title: "Device Login",
    children: `
      <div class="min-h-screen flex items-center justify-center p-4">
        <div class="fixed top-4 right-4 flex items-center gap-2 z-50">
          <button onclick="toggleLang()" class="theme-toggle w-8 h-8">
            <span class="text-xs font-semibold" id="__lang_btn"></span>
          </button>
          <button onclick="toggleTheme()" class="theme-toggle w-8 h-8">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5"/>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
          </button>
        </div>
        <script>document.getElementById('__lang_btn').textContent = window.__lang === 'zh' ? 'EN' : '中';</script>
        <div class="fixed top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-accent-violet/5 rounded-full blur-[120px] pointer-events-none"></div>

        <div class="w-full max-w-md" x-data="deviceApp()">
          <!-- Checking session -->
          <template x-if="checking">
            <div class="flex flex-col items-center gap-4 animate-in">
              <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-700 glow-border">
                <svg class="w-8 h-8 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                  <path d="M2 17l10 5 10-5"/>
                  <path d="M2 12l10 5 10-5"/>
                </svg>
              </div>
              <div class="flex items-center gap-2.5 text-themed-dim">
                <svg class="animate-spin h-4 w-4 text-accent-violet/60" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
                <span class="text-sm" x-text="t('device.checking')"></span>
              </div>
            </div>
          </template>

          <!-- Not logged in -->
          <template x-if="!checking && !loggedIn">
            <div class="text-center animate-in">
              <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-700 glow-border mb-6">
                <svg class="w-8 h-8 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                  <path d="M2 17l10 5 10-5"/>
                  <path d="M2 12l10 5 10-5"/>
                </svg>
              </div>
              <h1 class="text-2xl font-semibold tracking-tight text-themed mb-2" x-text="t('device.notLoggedIn')"></h1>
              <p class="text-sm text-themed-dim mb-6" x-text="t('device.notLoggedInHint')"></p>
              <a href="/" class="btn-primary inline-block no-underline" style="text-decoration:none" x-text="t('device.signIn')"></a>
            </div>
          </template>

          <!-- Logged in - show code entry -->
          <template x-if="!checking && loggedIn && !verified">
            <div>
              <div class="text-center mb-8 animate-in">
                <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-700 glow-border mb-6">
                  <svg class="w-8 h-8 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
                    <line x1="12" y1="18" x2="12" y2="18"/>
                  </svg>
                </div>
                <h1 class="text-2xl font-semibold tracking-tight text-themed" x-text="t('device.authorizeTitle')"></h1>
                <p class="text-sm text-themed-dim mt-2 font-light" x-text="t('device.authorizeSubtitle')"></p>
              </div>

              <div class="glass-card p-8 glow-primary animate-in delay-1">
                <form @submit.prevent="verify()">
                  <label class="block text-xs font-medium text-themed-secondary uppercase tracking-wider mb-3" x-text="t('device.codeLabel')"></label>
                  <input
                    type="text"
                    x-model="userCode"
                    placeholder="XXXX-XXXX"
                    maxlength="9"
                    class="text-center text-2xl tracking-[0.3em] font-mono"
                    style="letter-spacing: 0.3em; font-size: 1.5rem; text-transform: uppercase;"
                    @input="formatCode()"
                    autofocus
                  />

                  <template x-if="error">
                    <p class="text-accent-red text-sm mt-3 text-center" x-text="error"></p>
                  </template>

                  <button
                    type="submit"
                    class="btn-primary w-full mt-6"
                    :disabled="loading || userCode.length < 9"
                  >
                    <span x-show="!loading" x-text="t('device.authorize')"></span>
                    <span x-show="loading" class="flex items-center justify-center gap-2">
                      <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                      </svg>
                      <span x-text="t('common.verifying')"></span>
                    </span>
                  </button>
                </form>
              </div>

              <p class="text-center text-xs text-themed-dim mt-4 animate-in delay-2">
                <span x-text="t('device.signedInAs') + userName"></span>
              </p>
            </div>
          </template>

          <!-- Success -->
          <template x-if="verified">
            <div class="text-center animate-in">
              <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent-teal/10 mb-6" style="border: 1px solid rgba(16, 185, 129, 0.3);">
                <svg class="w-8 h-8 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
              <h1 class="text-2xl font-semibold tracking-tight text-themed mb-2" x-text="t('device.successTitle')"></h1>
              <p class="text-sm text-themed-dim" x-text="t('device.successHint')"></p>
            </div>
          </template>
        </div>
      </div>

      <script>
        function deviceApp() {
          return {
            checking: true,
            loggedIn: false,
            verified: false,
            loading: false,
            error: '',
            userCode: '',
            userName: '',
            sessionToken: '',

            async init() {
              // Check session via cookie
              try {
                const resp = await fetch('/auth/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'same-origin',
                  body: JSON.stringify({}),
                })
                if (resp.ok) {
                  const data = await resp.json()
                  if (data.ok && (data.isAdmin || data.isUser)) {
                    this.loggedIn = true
                    this.userName = data.userName || data.email || 'User'
                    this.sessionToken = data.sessionToken || ''
                  }
                }
              } catch {}
              this.checking = false

              // Pre-fill code from URL param
              const params = new URLSearchParams(window.location.search)
              const code = params.get('code')
              if (code) {
                this.userCode = code.toUpperCase()
              }
            },

            formatCode() {
              // Auto-format as XXXX-XXXX
              let raw = this.userCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8)
              if (raw.length > 4) {
                this.userCode = raw.slice(0, 4) + '-' + raw.slice(4)
              } else {
                this.userCode = raw
              }
            },

            async verify() {
              this.error = ''
              this.loading = true
              try {
                const resp = await fetch('/auth/device/verify', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'same-origin',
                  body: JSON.stringify({ user_code: this.userCode }),
                })
                const data = await resp.json()
                if (resp.ok && data.ok) {
                  this.verified = true
                } else {
                  this.error = data.error || t('device.verificationFailed')
                }
              } catch (e) {
                this.error = t('device.networkError')
              }
              this.loading = false
            },
          }
        }
      </script>
    `,
  })
}
