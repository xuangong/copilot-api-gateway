// Login page - Google OAuth with invite code support
import { Layout } from "./layout"

export function LoginPage(): string {
  return Layout({
    title: "Login",
    children: `
      <div class="min-h-screen flex items-center justify-center p-4">
        <div class="fixed top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-accent-violet/5 rounded-full blur-[120px] pointer-events-none"></div>

        <div class="w-full max-w-md" x-data="loginApp()">
          <!-- Auto-login check (cookie session) -->
          <template x-if="autoLogin">
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
                <span class="text-sm">Signing in...</span>
              </div>
            </div>
          </template>

          <template x-if="!autoLogin">
          <div>
          <!-- Main login view -->
          <template x-if="step === 'login'">
          <div>
          <div class="text-center mb-8 animate-in">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-700 glow-border mb-6">
              <svg class="w-8 h-8 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <h1 class="text-2xl font-semibold tracking-tight text-themed">Copilot Gateway</h1>
            <p class="text-sm text-themed-dim mt-2 font-light">Sign in to continue</p>
          </div>

          <div class="glass-card p-8 glow-primary animate-in delay-1">
            <!-- Google Sign In button -->
            <a href="/auth/google" class="btn-primary w-full flex items-center justify-center gap-3 no-underline" style="text-decoration:none">
              <svg class="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" opacity="0.9"/>
                <path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" opacity="0.8"/>
                <path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" opacity="0.7"/>
              </svg>
              Sign in with Google
            </a>

            <div class="flex items-center gap-3 my-5">
              <div class="flex-1 h-px" style="background: var(--glass-border)"></div>
              <span class="text-xs text-themed-dim">or</span>
              <div class="flex-1 h-px" style="background: var(--glass-border)"></div>
            </div>

            <button @click="step='email-login'" class="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl text-sm font-medium transition-all cursor-pointer border" style="background: transparent; border-color: var(--glass-border); color: var(--text-primary)">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
              </svg>
              Sign in with Email
            </button>

            <div class="mt-5 pt-5 border-t border-themed-border">
              <button @click="step='invite'" class="w-full text-center text-sm text-themed-dim hover:text-accent-violet transition-colors cursor-pointer bg-transparent border-0">
                I have an invite code
              </button>
            </div>
          </div>

          <div class="text-center mt-6 animate-in delay-2">
            <p class="text-xs text-themed-dim">
              Powered by GitHub Copilot API
            </p>
          </div>
          </div>
          </template>

          <!-- Invite code view -->
          <template x-if="step === 'invite'">
          <div>
          <div class="text-center mb-8 animate-in">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-700 glow-border mb-6">
              <svg class="w-8 h-8 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
                <polyline points="10 17 15 12 10 7"/>
                <line x1="15" y1="12" x2="3" y2="12"/>
              </svg>
            </div>
            <h1 class="text-2xl font-semibold tracking-tight text-themed">Enter Invite Code</h1>
            <p class="text-sm text-themed-dim mt-2 font-light">New users need an invite code to register</p>
          </div>

          <div class="glass-card p-8 glow-primary animate-in delay-1">
            <form @submit.prevent="validateInvite()" class="space-y-5">
              <div>
                <label class="block text-xs font-medium text-themed-secondary mb-2 uppercase tracking-widest">Invite Code</label>
                <input
                  type="text"
                  x-model="inviteCode"
                  placeholder="Enter your invite code..."
                  autofocus
                  required
                  style="text-transform: uppercase; letter-spacing: 0.1em"
                />
              </div>

              <template x-if="inviteValid">
                <div class="p-3 rounded-lg bg-accent-teal/10 border border-accent-teal/20 text-accent-teal text-sm">
                  Welcome, <span x-text="inviteName" class="font-medium"></span>! Click below to sign in and activate your account.
                </div>
              </template>

              <template x-if="!inviteValid">
                <button type="submit" class="btn-primary w-full" :disabled="loading || !inviteCode.trim()" style="background: var(--accent-teal, #2dd4bf)">
                  <span x-show="!loading">Verify Code</span>
                  <span x-show="loading" class="flex items-center justify-center gap-2">
                    <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                    </svg>
                    Verifying...
                  </span>
                </button>
              </template>

              <template x-if="inviteValid">
                <div>
                <a :href="'/auth/google?invite_code=' + encodeURIComponent(inviteCode)" class="btn-primary w-full flex items-center justify-center gap-3 no-underline" style="text-decoration:none">
                  <svg class="w-5 h-5" viewBox="0 0 24 24">
                    <path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                    <path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" opacity="0.9"/>
                    <path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" opacity="0.8"/>
                    <path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" opacity="0.7"/>
                  </svg>
                  Sign in with Google to activate
                </a>

                <div class="flex items-center gap-3 my-4">
                  <div class="flex-1 h-px" style="background: var(--glass-border)"></div>
                  <span class="text-xs text-themed-dim">or</span>
                  <div class="flex-1 h-px" style="background: var(--glass-border)"></div>
                </div>

                <button @click="step='email-register'; regName=inviteName" class="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl text-sm font-medium transition-all cursor-pointer border" style="background: transparent; border-color: var(--glass-border); color: var(--text-primary)">
                  <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
                  </svg>
                  Register with Email
                </button>
                </div>
              </template>

              <button type="button" @click="step='login'; error=''; inviteValid=false; inviteCode=''" class="w-full text-center text-xs text-themed-dim hover:text-themed-secondary transition-colors cursor-pointer bg-transparent border-0">
                Back to login
              </button>
            </form>

            <div x-show="error" x-transition class="mt-4 p-3 rounded-lg bg-accent-red/10 border border-accent-red/20 text-accent-red text-sm">
              <span x-text="error"></span>
            </div>
          </div>
          </div>
          </template>

          <!-- Email login view (password) -->
          <template x-if="step === 'email-login'">
          <div>
          <div class="text-center mb-8 animate-in">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-700 glow-border mb-6">
              <svg class="w-8 h-8 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
              </svg>
            </div>
            <h1 class="text-2xl font-semibold tracking-tight text-themed">Sign in with Email</h1>
            <p class="text-sm text-themed-dim mt-2 font-light">Enter your email and password</p>
          </div>

          <div class="glass-card p-8 glow-primary animate-in delay-1">
            <form @submit.prevent="emailLogin()" class="space-y-5">
              <div>
                <label class="block text-xs font-medium text-themed-secondary mb-2 uppercase tracking-widest">Email</label>
                <input type="email" x-model="loginEmail" placeholder="you@example.com" autofocus required />
              </div>
              <div>
                <label class="block text-xs font-medium text-themed-secondary mb-2 uppercase tracking-widest">Password</label>
                <input type="password" x-model="loginPassword" placeholder="Enter your password" required />
              </div>
              <button type="submit" class="btn-primary w-full" :disabled="loading || !loginEmail.trim() || !loginPassword">
                <span x-show="!loading">Sign In</span>
                <span x-show="loading" class="flex items-center justify-center gap-2">
                  <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                    <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                  </svg>
                  Signing in...
                </span>
              </button>
            </form>

            <div x-show="error" x-transition class="mt-4 p-3 rounded-lg bg-accent-red/10 border border-accent-red/20 text-accent-red text-sm">
              <span x-text="error"></span>
            </div>

            <button type="button" @click="step='login'; error=''; loginEmail=''; loginPassword=''" class="w-full text-center text-xs text-themed-dim hover:text-themed-secondary transition-colors cursor-pointer bg-transparent border-0 mt-5">
              Back to login
            </button>
          </div>
          </div>
          </template>

          <!-- Email register view (verification code) -->
          <template x-if="step === 'email-register'">
          <div>
          <div class="text-center mb-8 animate-in">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-700 glow-border mb-6">
              <svg class="w-8 h-8 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
              </svg>
            </div>
            <h1 class="text-2xl font-semibold tracking-tight text-themed">Register with Email</h1>
            <p class="text-sm text-themed-dim mt-2 font-light">Create your account with a verification code</p>
          </div>

          <div class="glass-card p-8 glow-primary animate-in delay-1">
            <template x-if="!codeSent">
            <form @submit.prevent="sendRegisterCode()" class="space-y-5">
              <div>
                <label class="block text-xs font-medium text-themed-secondary mb-2 uppercase tracking-widest">Name</label>
                <input type="text" :value="regName" disabled style="opacity: 0.7; cursor: not-allowed" />
              </div>
              <div>
                <label class="block text-xs font-medium text-themed-secondary mb-2 uppercase tracking-widest">Email</label>
                <input type="email" x-model="regEmail" placeholder="you@example.com" autofocus required />
              </div>
              <div>
                <label class="block text-xs font-medium text-themed-secondary mb-2 uppercase tracking-widest">Password</label>
                <input type="password" x-model="regPassword" placeholder="At least 6 characters" minlength="6" required />
              </div>
              <button type="submit" class="btn-primary w-full" :disabled="loading || !regEmail.trim() || !regName.trim() || regPassword.length < 6" style="background: var(--accent-teal, #2dd4bf)">
                <span x-show="!loading">Send Verification Code</span>
                <span x-show="loading" class="flex items-center justify-center gap-2">
                  <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                    <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                  </svg>
                  Sending...
                </span>
              </button>
            </form>
            </template>

            <template x-if="codeSent">
            <form @submit.prevent="verifyRegisterCode()" class="space-y-5">
              <div class="p-3 rounded-lg bg-accent-teal/10 border border-accent-teal/20 text-sm text-themed-secondary">
                Code sent to <span class="font-medium" x-text="regEmail"></span>
              </div>
              <div>
                <label class="block text-xs font-medium text-themed-secondary mb-2 uppercase tracking-widest">Verification Code</label>
                <input type="text" x-model="regCode" placeholder="000000" maxlength="6" required
                  style="text-align: center; letter-spacing: 0.3em; font-size: 1.25rem; font-weight: 600"
                  @input="regCode = regCode.replace(/[^0-9]/g, '')" />
              </div>
              <button type="submit" class="btn-primary w-full" :disabled="loading || regCode.length !== 6" style="background: var(--accent-teal, #2dd4bf)">
                <span x-show="!loading">Create Account</span>
                <span x-show="loading" class="flex items-center justify-center gap-2">
                  <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                    <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                  </svg>
                  Creating...
                </span>
              </button>
            </form>
            </template>

            <div x-show="error" x-transition class="mt-4 p-3 rounded-lg bg-accent-red/10 border border-accent-red/20 text-accent-red text-sm">
              <span x-text="error"></span>
            </div>

            <button type="button" @click="step='invite'; error=''; codeSent=false; regCode=''" class="w-full text-center text-xs text-themed-dim hover:text-themed-secondary transition-colors cursor-pointer bg-transparent border-0 mt-5">
              Back
            </button>
          </div>
          </div>
          </template>

          </div>
          </template>
        </div>
      </div>

      <script>
        function loginApp() {
          return {
            loading: false,
            autoLogin: false,
            error: '',
            step: 'login',
            inviteCode: '',
            inviteName: '',
            inviteValid: false,
            // Email login
            loginEmail: '',
            loginPassword: '',
            // Email register
            regEmail: '',
            regName: '',
            regPassword: '',
            regCode: '',
            codeSent: false,
            init() {
              // Try auto-login via cookie session (HttpOnly cookie not readable by JS)
              this.autoLogin = true;
              this.checkSession();
            },
            async checkSession() {
              try {
                const resp = await fetch('/auth/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({}),
                  credentials: 'same-origin',
                });
                const data = await resp.json();
                if (data.ok) {
                  localStorage.setItem('isAdmin', data.isAdmin ? '1' : '0');
                  localStorage.setItem('isUser', data.isUser ? '1' : '0');
                  if (data.userId) localStorage.setItem('userId', data.userId);
                  if (data.userName) localStorage.setItem('userName', data.userName);
                  if (data.email) localStorage.setItem('userEmail', data.email);
                  window.location.href = '/dashboard';
                } else {
                  this.autoLogin = false;
                }
              } catch {
                this.autoLogin = false;
              }
            },
            async validateInvite() {
              if (!this.inviteCode.trim()) return;
              this.loading = true;
              this.error = '';
              try {
                const resp = await fetch('/auth/validate-invite', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ code: this.inviteCode.trim().toUpperCase() }),
                });
                const data = await resp.json();
                if (data.valid) {
                  this.inviteValid = true;
                  this.inviteName = data.name;
                } else {
                  this.error = 'Invalid or already used invite code';
                }
              } catch {
                this.error = 'Connection error';
              } finally {
                this.loading = false;
              }
            },
            async emailLogin() {
              if (!this.loginEmail.trim() || !this.loginPassword) return;
              this.loading = true;
              this.error = '';
              try {
                const resp = await fetch('/auth/email/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ email: this.loginEmail.trim(), password: this.loginPassword }),
                  credentials: 'same-origin',
                });
                const data = await resp.json();
                if (data.ok) {
                  window.location.href = data.redirect || '/dashboard';
                } else {
                  this.error = data.error || 'Login failed';
                }
              } catch {
                this.error = 'Connection error';
              } finally {
                this.loading = false;
              }
            },
            async sendRegisterCode() {
              if (!this.regEmail.trim() || !this.regName.trim() || this.regPassword.length < 6) return;
              this.loading = true;
              this.error = '';
              try {
                const resp = await fetch('/auth/email/register', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    email: this.regEmail.trim(),
                    invite_code: this.inviteCode.trim().toUpperCase(),
                    name: this.regName.trim(),
                    password: this.regPassword,
                  }),
                });
                const data = await resp.json();
                if (data.ok) {
                  this.codeSent = true;
                } else {
                  this.error = data.error || 'Failed to send code';
                }
              } catch {
                this.error = 'Connection error';
              } finally {
                this.loading = false;
              }
            },
            async verifyRegisterCode() {
              if (this.regCode.length !== 6) return;
              this.loading = true;
              this.error = '';
              try {
                const resp = await fetch('/auth/email/verify', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    email: this.regEmail.trim(),
                    code: this.regCode,
                  }),
                });
                const data = await resp.json();
                if (data.ok) {
                  window.location.href = data.redirect || '/dashboard';
                } else {
                  this.error = data.error || 'Verification failed';
                }
              } catch {
                this.error = 'Connection error';
              } finally {
                this.loading = false;
              }
            }
          }
        }
      </script>`,
  })
}
