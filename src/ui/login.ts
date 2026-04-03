// Login page - key input with dark design
import { Layout } from "./layout"

export function LoginPage(): string {
  return Layout({
    title: "Login",
    children: `
      <div class="min-h-screen flex items-center justify-center p-4">
        <div class="fixed top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-accent-cyan/5 rounded-full blur-[120px] pointer-events-none"></div>

        <div class="w-full max-w-md" x-data="loginApp()">
          <template x-if="autoLogin">
            <div class="flex flex-col items-center gap-4 animate-in">
              <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-700 glow-border">
                <svg class="w-8 h-8 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                  <path d="M2 17l10 5 10-5"/>
                  <path d="M2 12l10 5 10-5"/>
                </svg>
              </div>
              <div class="flex items-center gap-2.5 text-gray-400">
                <svg class="animate-spin h-4 w-4 text-accent-cyan/60" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
                <span class="text-sm">Signing in…</span>
              </div>
            </div>
          </template>

          <template x-if="!autoLogin">
          <div>
          <template x-if="step === 'login'">
          <div>
          <div class="text-center mb-8 animate-in">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-700 glow-border mb-6">
              <svg class="w-8 h-8 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <h1 class="text-2xl font-semibold tracking-tight text-white">Copilot Gateway</h1>
            <p class="text-sm text-gray-500 mt-2 font-light">Enter your key to continue</p>
          </div>

          <div class="glass-card p-8 glow-cyan animate-in delay-1">
            <p class="text-xs text-gray-500 mb-6 leading-relaxed">Log in with <span class="text-gray-400">ADMIN_KEY</span>, <span class="text-gray-400">User Key</span>, <span class="text-gray-400">API key</span>, or <span class="text-gray-400">invite code</span>.</p>

            <form @submit.prevent="login()" class="space-y-5">
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-2 uppercase tracking-widest">Key</label>
                <input
                  type="password"
                  x-model="authKey"
                  placeholder="Enter your key..."
                  autofocus
                  required
                />
              </div>

              <button type="submit" class="btn-primary w-full" :disabled="loading">
                <span x-show="!loading">Authenticate</span>
                <span x-show="loading" class="flex items-center justify-center gap-2">
                  <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                    <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                  </svg>
                  Authenticating...
                </span>
              </button>
            </form>

            <div x-show="error" x-transition class="mt-4 p-3 rounded-lg bg-accent-rose/10 border border-accent-rose/20 text-accent-rose text-sm">
              <span x-text="error"></span>
            </div>
          </div>

          <div class="text-center mt-6 animate-in delay-2">
            <p class="text-xs text-gray-600">
              Powered by GitHub Copilot API
            </p>
          </div>
          </div>
          </template>

          <template x-if="step === 'setKey'">
          <div>
          <div class="text-center mb-8 animate-in">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface-700 glow-border mb-6">
              <svg class="w-8 h-8 text-accent-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </div>
            <h1 class="text-2xl font-semibold tracking-tight text-white">Welcome, <span x-text="inviteName" class="text-accent-cyan"></span></h1>
            <p class="text-sm text-gray-500 mt-2 font-light">Set your User Key for future logins</p>
          </div>

          <div class="glass-card p-8 glow-cyan animate-in delay-1">
            <p class="text-xs text-gray-500 mb-6 leading-relaxed">Choose a <span class="text-gray-400">User Key</span> (min 8 characters). You'll use this to log in from now on.</p>

            <form @submit.prevent="register()" class="space-y-5">
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-2 uppercase tracking-widest">User Key</label>
                <input
                  type="password"
                  x-model="userKey"
                  placeholder="Set your User Key (min 8 chars)..."
                  autofocus
                  required
                  minlength="8"
                />
              </div>

              <button type="submit" class="btn-primary w-full" :disabled="loading || userKey.length < 8">
                <span x-show="!loading">Create Account</span>
                <span x-show="loading" class="flex items-center justify-center gap-2">
                  <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                    <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                  </svg>
                  Creating...
                </span>
              </button>

              <button type="button" @click="step='login'; error=''" class="w-full text-center text-xs text-gray-500 hover:text-gray-400 transition-colors">
                Back to login
              </button>
            </form>

            <div x-show="error" x-transition class="mt-4 p-3 rounded-lg bg-accent-rose/10 border border-accent-rose/20 text-accent-rose text-sm">
              <span x-text="error"></span>
            </div>
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
            authKey: '',
            loading: false,
            autoLogin: false,
            error: '',
            step: 'login',
            inviteName: '',
            inviteCode: '',
            userKey: '',
            init() {
              const stored = localStorage.getItem('authKey');
              if (stored) {
                this.authKey = stored;
                this.autoLogin = true;
                this.login();
              }
            },
            async login() {
              this.loading = true;
              this.error = '';
              try {
                const resp = await fetch('/auth/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ key: this.authKey }),
                });
                const data = await resp.json();
                if (data.ok) {
                  // Store session token if provided, otherwise keep the key
                  const authToken = data.sessionToken || this.authKey;
                  localStorage.setItem('authKey', authToken);
                  localStorage.setItem('isAdmin', data.isAdmin ? '1' : '0');
                  localStorage.setItem('isUser', data.isUser ? '1' : '0');
                  if (data.userId) localStorage.setItem('userId', data.userId);
                  if (data.userName) localStorage.setItem('userName', data.userName);
                  if (!data.isAdmin && !data.isUser) {
                    localStorage.setItem('login_key_id', data.keyId);
                    localStorage.setItem('login_key_name', data.keyName);
                    localStorage.setItem('login_key_hint', data.keyHint);
                  } else {
                    localStorage.removeItem('login_key_id');
                    localStorage.removeItem('login_key_name');
                    localStorage.removeItem('login_key_hint');
                  }
                  window.location.href = '/dashboard';
                } else if (data.needSetKey) {
                  // Invite code valid, need to set User Key
                  this.inviteName = data.name;
                  this.inviteCode = this.authKey;
                  this.authKey = '';
                  this.step = 'setKey';
                  this.autoLogin = false;
                } else {
                  localStorage.removeItem('authKey');
                  localStorage.removeItem('isAdmin');
                  this.autoLogin = false;
                  this.error = data.error || 'Authentication failed';
                }
              } catch (e) {
                this.autoLogin = false;
                this.error = 'Connection error';
              } finally {
                this.loading = false;
              }
            },
            async register() {
              if (this.userKey.length < 8) {
                this.error = 'User Key must be at least 8 characters';
                return;
              }
              this.loading = true;
              this.error = '';
              try {
                const resp = await fetch('/auth/register', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ inviteCode: this.inviteCode, userKey: this.userKey }),
                });
                const data = await resp.json();
                if (data.ok) {
                  // Store the User Key for future logins
                  localStorage.setItem('authKey', this.userKey);
                  localStorage.setItem('isAdmin', '0');
                  localStorage.setItem('isUser', '1');
                  if (data.userId) localStorage.setItem('userId', data.userId);
                  if (data.userName) localStorage.setItem('userName', data.userName);
                  localStorage.removeItem('login_key_id');
                  localStorage.removeItem('login_key_name');
                  localStorage.removeItem('login_key_hint');
                  window.location.href = '/dashboard';
                } else {
                  this.error = data.error || 'Registration failed';
                }
              } catch (e) {
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
