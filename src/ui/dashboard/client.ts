// Dashboard Alpine.js client-side JavaScript
export function dashboardAssets(): string {
  return `
    <style>
    select option { background: var(--surface-800); color: var(--text-primary); }
    </style>

    <script>
    function dashboardApp() {
    const isAdmin = localStorage.getItem('isAdmin') === '1';
    const isUser = localStorage.getItem('isUser') === '1';
    const TABS = isAdmin ? ['upstream', 'users', 'keys', 'usage', 'latency', 'settings'] : (isUser ? ['upstream', 'keys', 'usage', 'latency'] : ['keys', 'usage', 'latency']);
    const defaultTab = isAdmin ? 'upstream' : (isUser ? 'upstream' : 'keys');
    const initTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultTab;

    const CLAUDE_TIER = { opus: 0, sonnet: 1, haiku: 2 };

    function claudeTier(id) {
      for (const t in CLAUDE_TIER) {
        if (id.includes(t)) return CLAUDE_TIER[t];
      }
      return 99;
    }

    function sortClaudeBig(a, b) {
      const ta = claudeTier(a);
      const tb = claudeTier(b);
      return ta !== tb ? ta - tb : b.localeCompare(a);
    }

    function sortClaudeSmall(a, b) {
      const ta = claudeTier(a);
      const tb = claudeTier(b);
      return ta !== tb ? tb - ta : b.localeCompare(a);
    }

    function sortCodex(a, b) {
      const am = a.includes('mini') ? 1 : 0;
      const bm = b.includes('mini') ? 1 : 0;
      return am !== bm ? am - bm : b.localeCompare(a);
    }

    // Refined cool palettes — clean, readable, not muddy; slightly muted from Apple system colors
    const PALETTE_LIGHT = ['#4E6CF5','#2CA87A','#D88A2E','#8058C8','#C85878','#1E98A0','#9B60B8','#2E9080','#5078C0','#5A9850'];
    const PALETTE_DARK  = ['#7B90FF','#50D48A','#F0B050','#A880F0','#F07898','#50C5D0','#C098E0','#58CCB0','#7098E0','#90C880'];

    return {
      authKey: '',
      isAdmin,
      isUser,
      tab: initTab,
      meLoaded: false,
      githubAccounts: [],
      githubConnected: false,
      usageData: null,
      usageError: false,
      usagePercent: 0,
      deviceFlow: { loading: false, userCode: null, verificationUri: null, deviceCode: null, pollTimer: null },
      keys: [],
      keysLoading: false,
      now: Date.now(),
      newKeyName: '',
      selectedKeyId: null,
      keyCreating: false,
      keyDeleting: null,
      keyRotating: null,
      copied: false,
      modelsLoaded: false,
      claudeModelsBig: [],
      claudeModelsSmall: [],
      claudeModel: '',
      claudeSmallModel: '',
      codexModels: [],
      codexModel: '',
      geminiModels: [],
      geminiModel: '',
      configTab: 'claude',
      tokenRange: 'today',
      tokenWeekOffset: 0,
      tokenData: [],
      tokenChart: null,
      tokenLoading: false,
      tokenSummary: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      tokenByModel: [],
      hoveredModel: null,

      // Multi-dimension filters
      tokenFilterKey: '',       // '' = All Keys
      tokenFilterClient: '',    // '' = All Clients
      tokenFilterModel: '',     // '' = All Models
      tokenFilterUser: '',      // '' = All Users (admin only)
      tokenAvailableKeys: [],   // [{id, name}]
      tokenAvailableClients: [],// string[]
      tokenAvailableModels: [], // string[]
      tokenAvailableUsers: [],  // [{id, name}] (admin only)
      tokenByKey: [],           // distribution by key
      tokenByClient: [],        // distribution by client
      tokenByUser: [],          // distribution by user (admin only)
      hoveredDist: null,        // hovered item in any distribution

      modelColors: isDarkTheme() ? PALETTE_DARK : PALETTE_LIGHT,

      modelPercent(field) {
        const total = this.tokenByModel.reduce((s, m) => s + m[field], 0);
        if (!total) return this.tokenByModel.map(() => 0);
        return this.tokenByModel.map((m) => Math.round(m[field] / total * 1000) / 10);
      },
      exportLoading: false,
      importFile: null,
      importData: null,
      importMode: 'merge',
      importLoading: false,
      importPreview: { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0 },
      latencyRange: 'today',
      latencyWeekOffset: 0,
      latencyData: [],
      latencyChart: null,
      latencyLoading: false,
      latencySummary: { avgTotal: 0, avgUpstream: 0, avgTtfb: 0, tokenMissRate: 0 },
      latencyByColo: [],
      latencyByType: [],
      latencyModels: [],
      latencyModel: '',

      // User management (admin)
      adminUsers: [],
      adminUsersLoading: false,
      inviteCodes: [],
      inviteCodesLoading: false,
      newInviteName: '',
      inviteCreating: false,

      get baseUrl() { return location.origin; },

      get activeKey() {
        const sel = this.selectedKeyId && this.keys.find((k) => k.id === this.selectedKeyId);
        if (sel) return sel.key;
        if (this.keys.length > 0) return this.keys[0].key;
        return '<your-api-key>';
      },

      truncateKey(key) {
        if (!key || key.length <= 12) return key;
        return key.slice(0, 4) + '\\u2026' + key.slice(-4);
      },

      timeAgo(dateStr) {
        if (!dateStr) return null;
        const date = new Date(dateStr);
        const diff = this.now - date;
        const seconds = Math.floor(diff / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
        const days = Math.floor(hours / 24);
        if (days <= 30) return days + (days === 1 ? ' day ago' : ' days ago');
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      },

      fullDateTime(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
          + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        },

        claudeCodeSnippet() {
          const lines = [
            'export ANTHROPIC_BASE_URL=' + this.baseUrl,
            'export ANTHROPIC_AUTH_TOKEN=' + this.activeKey,
            'export ANTHROPIC_MODEL=' + this.claudeModel,
            'export ANTHROPIC_SMALL_FAST_MODEL=' + this.claudeSmallModel,
          ];
          return lines.join('\\n');
        },

        codexSnippet() {
          const lines = [
            'model = "' + this.codexModel + '"',
            'model_provider = "copilot_gateway"',
            '',
            '[model_providers.copilot_gateway]',
            'name = "Copilot Gateway"',
            'base_url = "' + this.baseUrl + '/"',
            'env_key = "OPENAI_API_KEY"',
            'wire_api = "responses"',
          ];
          return lines.join('\\n');
        },

        codexEnvSnippet() {
          return 'export OPENAI_API_KEY=' + this.activeKey;
        },

        codexStartSnippet() {
          return 'codex -c model_provider=copilot_gateway -m ' + this.codexModel;
        },

        geminiSnippet() {
          const lines = [
            'export GEMINI_API_KEY=' + this.activeKey,
            'export GEMINI_API_BASE_URL=' + this.baseUrl,
            'export GEMINI_MODEL=' + this.geminiModel,
          ];
          return lines.join('\\n');
        },

        init() {
          if (this._initialized) return;
          this._initialized = true;
          this.authKey = localStorage.getItem('authKey') || '';
          if (!this.authKey) {
            window.location.href = '/';
            return;
          }

          this.loadModels();

          if ((this.tab === 'upstream') && (this.isAdmin || this.isUser)) {
            this.loadMe();
            this.loadUsage();
          } else if (this.tab === 'users' && this.isAdmin) {
            this.loadInviteCodes();
            this.loadAdminUsers();
          } else if (this.tab === 'keys') {
            this.loadKeys();
          } else if (this.tab === 'usage') {
            this.tokenLoading = true;
            this.fetchTokenData().then(() => {
              if (this.tab === 'usage') {
                this.$nextTick().then(() => this.renderTokenChart());
              }
            }).catch(() => {});
          } else if (this.tab === 'latency') {
            this.latencyLoading = true;
            this.fetchLatencyData().then(() => {
              if (this.tab === 'latency') {
                this.$nextTick().then(() => this.renderLatencyChart());
              }
            });
          }

          setInterval(() => {
            if (this.tab === 'upstream' && (this.isAdmin || this.isUser)) this.loadUsage();
            if (this.tab === 'usage') this.loadTokenUsage();
            if (this.tab === 'latency') this.loadLatencyData();
          }, 60000);

          setInterval(() => {
            this.now = Date.now();
          }, 30000);

          window.addEventListener('hashchange', () => {
            const h = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultTab;
            if (this.tab !== h) this.switchTab(h);
          });

          window.addEventListener('theme-changed', () => {
            this.modelColors = isDarkTheme() ? PALETTE_DARK : PALETTE_LIGHT;
            if (this.tab === 'usage' && this.tokenData.length) {
              this.$nextTick().then(() => this.renderTokenChart());
            } else if (this.tab === 'latency' && this.latencyData.length) {
              this.$nextTick().then(() => this.renderLatencyChart());
            }
          });
        },

        authHeaders() { return { 'x-api-key': this.authKey }; },

        async switchTab(t) {
          if (t !== 'usage' && this.tokenChart) {
            this.tokenChart.stop();
            this.tokenChart.destroy();
            this.tokenChart = null;
          }
          if (t !== 'latency' && this.latencyChart) {
            this.latencyChart.stop();
            this.latencyChart.destroy();
            this.latencyChart = null;
          }
          this.tab = t;
          location.hash = '#' + t;
          if (t === 'upstream' && (this.isAdmin || this.isUser)) {
            if (!this.meLoaded) this.loadMe();
            this.loadUsage();
          } else if (t === 'users' && this.isAdmin) {
            this.loadInviteCodes();
            this.loadAdminUsers();
          } else if (t === 'usage') {
            this.tokenLoading = true;
            await this.fetchTokenData();
            if (this.tab === 'usage') {
              await this.$nextTick();
              this.renderTokenChart();
            }
          } else if (t === 'latency') {
            this.latencyLoading = true;
            await this.fetchLatencyData();
            if (this.tab === 'latency') {
              await this.$nextTick();
              this.renderLatencyChart();
            }
          } else if (t === 'keys') {
            await this.loadKeys();
          }
        },

        async loadModels() {
          try {
            const resp = await fetch('/api/models', { headers: this.authHeaders() });
            if (!resp.ok) return;
            const { data } = await resp.json();

            const claudeAll = data
              .filter((m) => m.id.startsWith('claude-') && m.supported_endpoints?.includes('/v1/messages'))
              .map((m) => m.id);

              this.claudeModelsBig = [...claudeAll].sort(sortClaudeBig);
              this.claudeModelsSmall = [...claudeAll].sort(sortClaudeSmall);
              this.claudeModel = this.claudeModelsBig[0] || '';
              this.claudeSmallModel = this.claudeModelsSmall[0] || '';

              this.codexModels = data
                .filter((m) => m.id.startsWith('gpt-') && m.supported_endpoints?.includes('/responses'))
                .map((m) => m.id)
                .sort(sortCodex);
              this.codexModel = this.codexModels[0] || '';

              this.geminiModels = data
                .filter((m) => m.id.startsWith('gemini-'))
                .map((m) => m.id);
              this.geminiModel = this.geminiModels[0] || '';

              this.modelsLoaded = true;
            } catch {}
          },

          async loadMe() {
            try {
              const resp = await fetch('/auth/me', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              const data = await resp.json();
              this.githubConnected = data.github_connected;
              this.githubAccounts = data.accounts || [];
            } catch (e) {
              console.error('loadMe:', e);
            } finally {
              this.meLoaded = true;
            }
          },

          async loadUsage() {
            try {
              const resp = await fetch('/api/copilot-quota', { headers: this.authHeaders() });
              if (resp.status === 401) {
                // GitHub token expired, not auth issue — don't kick to login
                this.usageError = true;
                return;
              }
              if (resp.ok) {
                this.usageData = await resp.json();
                const pi = this.usageData.quota_snapshots.premium_interactions;
                this.usagePercent = pi.entitlement > 0
                  ? Math.round(((pi.entitlement - pi.remaining) / pi.entitlement) * 100)
                  : 0;
                this.usageError = false;
              } else {
                this.usageError = true;
              }
            } catch {
              this.usageError = true;
            }
          },

          formatDate(s) {
            return s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
          },

          async startGithubAuth() {
            this.deviceFlow.loading = true;
            try {
              const resp = await fetch('/auth/github', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              const d = await resp.json();
              if (d.user_code) {
                Object.assign(this.deviceFlow, {
                  userCode: d.user_code,
                  verificationUri: d.verification_uri,
                  deviceCode: d.device_code,
                });
                try { await navigator.clipboard.writeText(d.user_code); } catch {}
                this.pollDeviceFlow(d.interval || 5);
              }
            } catch (e) {
              console.error('startGithubAuth:', e);
            } finally {
              this.deviceFlow.loading = false;
            }
          },

          pollDeviceFlow(interval) {
            this.deviceFlow.pollTimer = setInterval(async () => {
              try {
                const resp = await fetch('/auth/github/poll', {
                  method: 'POST',
                  headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                  body: JSON.stringify({ device_code: this.deviceFlow.deviceCode }),
                });
                if (resp.status === 401) {
                  this.kickToLogin();
                  return;
                }
                const d = await resp.json();
                if (d.status === 'complete') {
                  this.cancelDeviceFlow();
                  await this.loadMe();
                  this.githubConnected = this.githubAccounts.length > 0;
                  await this.loadUsage();
                } else if (d.status === 'slow_down') {
                  clearInterval(this.deviceFlow.pollTimer);
                  this.pollDeviceFlow((d.interval || interval) + 1);
                } else if (d.status === 'error') {
                  this.cancelDeviceFlow();
                  alert('Authorization failed: ' + d.error);
                }
              } catch (e) {
                console.error('poll:', e);
              }
            }, interval * 1000);
          },

          cancelDeviceFlow() {
            clearInterval(this.deviceFlow.pollTimer);
            Object.assign(this.deviceFlow, {
              pollTimer: null,
              userCode: null,
              verificationUri: null,
              deviceCode: null,
            });
          },

          async disconnectGithub(userId, login) {
            if (!confirm('Disconnect @' + login + '? The stored token will be deleted.')) return;
            try {
              const resp = await fetch('/auth/github/' + userId, { method: 'DELETE', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                await this.loadMe();
                this.githubConnected = this.githubAccounts.length > 0;
                if (!this.githubConnected) {
                  this.usageData = null;
                  this.usageError = false;
                  this.usagePercent = 0;
                } else {
                  await this.loadUsage();
                }
              } else {
                alert('Failed to disconnect GitHub account');
              }
            } catch (e) {
              console.error('disconnectGithub:', e);
            }
          },

          async switchGithubAccount(userId) {
            try {
              const resp = await fetch('/auth/github/switch', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId }),
              });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                await this.loadMe();
                await this.loadUsage();
              } else {
                alert('Failed to switch account');
              }
            } catch (e) {
              console.error('switchGithubAccount:', e);
            }
          },

          async loadKeys() {
            this.keysLoading = true;
            try {
              const resp = await fetch('/api/keys', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                this.keys = await resp.json();
                if (this.selectedKeyId && !this.keys.some((k) => k.id === this.selectedKeyId)) {
                  this.selectedKeyId = null;
                }
              }
            } catch (e) {
              console.error('loadKeys:', e);
            } finally {
              this.keysLoading = false;
            }
          },

          async createNewKey() {
            const name = this.newKeyName.trim();
            if (!name) return;
            this.keyCreating = true;
            try {
              const resp = await fetch('/api/keys', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
              });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                const created = await resp.json();
                this.selectedKeyId = created.id;
                this.newKeyName = '';
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to create key');
              }
            } catch (e) {
              console.error('createKey:', e);
            } finally {
              this.keyCreating = false;
            }
          },

          async deleteKeyById(id, name) {
            if (!confirm('Delete key "' + name + '"? This cannot be undone.')) return;
            this.keyDeleting = id;
            try {
              const resp = await fetch('/api/keys/' + id, { method: 'DELETE', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to delete key');
              }
            } catch (e) {
              console.error('deleteKey:', e);
            } finally {
              this.keyDeleting = null;
            }
          },

          async rotateKeyById(id, name) {
            if (!confirm('Rotate key "' + name + '"? The old key will stop working immediately.')) return;
            this.keyRotating = id;
            try {
              const resp = await fetch('/api/keys/' + id + '/rotate', { method: 'POST', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                this.selectedKeyId = id;
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to rotate key');
              }
            } catch (e) {
              console.error('rotateKey:', e);
            } finally {
              this.keyRotating = null;
            }
          },

          async renameKeyById(id, currentName) {
            const newName = prompt('Rename key:', currentName);
            if (!newName || newName === currentName) return;
            try {
              const resp = await fetch('/api/keys/' + id, {
                method: 'PATCH',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName }),
              });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to rename key');
              }
            } catch (e) {
              console.error('renameKey:', e);
            }
          },

          async copySnippet(text, tag) {
            try {
              await navigator.clipboard.writeText(text);
            } catch {
              const ta = document.createElement('textarea');
              ta.value = text;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
            }
            this.copied = tag;
            setTimeout(() => {
              this.copied = false;
            }, 2000);
          },

          localHourKey(d) {
            const p = (n) => String(n).padStart(2, '0');
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours());
          },

          localDateKey(d) {
            const p = (n) => String(n).padStart(2, '0');
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
          },

          async fetchTokenData() {
            this.tokenLoading = true;
            try {
              const now = new Date();
              let rangeStart, rangeEnd;
              if (this.tokenRange === 'week') {
                // ISO week: Monday to Sunday
                const ref = new Date(now);
                ref.setDate(ref.getDate() + this.tokenWeekOffset * 7);
                const day = ref.getDay();
                const monday = new Date(ref);
                monday.setDate(ref.getDate() - ((day + 6) % 7));
                monday.setHours(0, 0, 0, 0);
                const sunday = new Date(monday);
                sunday.setDate(monday.getDate() + 7);
                sunday.setHours(0, 0, 0, 0);
                rangeStart = monday;
                rangeEnd = sunday;
              } else {
                rangeStart = new Date(now);
                if (this.tokenRange === 'today') {
                  rangeStart.setHours(0, 0, 0, 0);
                } else if (this.tokenRange === '7d') {
                  rangeStart.setDate(rangeStart.getDate() - 6);
                  rangeStart.setHours(0, 0, 0, 0);
                } else {
                  rangeStart.setDate(rangeStart.getDate() - 29);
                  rangeStart.setHours(0, 0, 0, 0);
                }
                rangeEnd = new Date(now.getTime() + 3600000);
              }
              const start = rangeStart.toISOString().slice(0, 13);
              const end = rangeEnd.toISOString().slice(0, 13);
              const resp = await fetch('/api/token-usage?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end), { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) this.tokenData = await resp.json();
            } catch (e) {
              console.error('fetchTokenData:', e);
            } finally {
              this.tokenLoading = false;
            }
          },

          async loadTokenUsage() {
            await this.fetchTokenData();
            if (this.tab !== 'usage') return;
            await this.$nextTick();
            this.renderTokenChart();
          },

          renderTokenChart() {
            const canvas = document.getElementById('tokenChart');
            if (!canvas || canvas.clientWidth === 0 || !canvas.getContext) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            const palette = isDarkTheme() ? PALETTE_DARK : PALETTE_LIGHT;
            const _dark = isDarkTheme();
            const isDaily = this.tokenRange !== 'today';
            const allData = this.tokenData;

            // Extract available dimensions from all data (before filtering)
            const keyNameMap = new Map();
            const keySet = new Set();
            const clientSet = new Set();
            const modelSet = new Set();
            const userMap = new Map();
            for (const r of allData) {
              keyNameMap.set(r.keyId, r.keyName);
              keySet.add(r.keyId);
              if (r.client) clientSet.add(r.client);
              if (r.model) modelSet.add(r.model);
              if (r.ownerId) userMap.set(r.ownerId, r.ownerName || r.ownerId.slice(0, 8));
            }
            this.tokenAvailableKeys = [...keySet].map(id => ({ id, name: keyNameMap.get(id) || id.slice(0, 8) })).sort((a, b) => a.name.localeCompare(b.name));
            this.tokenAvailableClients = [...clientSet].sort();
            this.tokenAvailableModels = [...modelSet].sort();
            if (this.isAdmin) {
              this.tokenAvailableUsers = [...userMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
            }

            // Apply filters
            let data = allData;
            if (this.tokenFilterKey) data = data.filter(r => r.keyId === this.tokenFilterKey);
            if (this.tokenFilterClient) data = data.filter(r => r.client === this.tokenFilterClient);
            if (this.tokenFilterModel) data = data.filter(r => r.model === this.tokenFilterModel);
            if (this.tokenFilterUser) data = data.filter(r => r.ownerId === this.tokenFilterUser);

            // Summary
            let totalReqs = 0;
            let totalIn = 0;
            let totalOut = 0;
            let totalCacheRead = 0;
            let totalCacheCreation = 0;
            for (const r of data) {
              totalReqs += r.requests;
              totalIn += r.inputTokens;
              totalOut += r.outputTokens;
              totalCacheRead += r.cacheReadTokens || 0;
              totalCacheCreation += r.cacheCreationTokens || 0;
            }
            this.tokenSummary = { requests: totalReqs, input: totalIn, output: totalOut, cacheRead: totalCacheRead, cacheCreation: totalCacheCreation };

            // Build distributions for each "All" dimension
            // By Model (when model filter is All)
            if (!this.tokenFilterModel) {
              const mMap = new Map();
              for (const r of data) {
                const m = r.model || 'unknown';
                const existing = mMap.get(m);
                if (existing) {
                  existing.requests += r.requests;
                  existing.input += r.inputTokens;
                  existing.output += r.outputTokens;
                } else {
                  mMap.set(m, { model: m, requests: r.requests, input: r.inputTokens, output: r.outputTokens });
                }
              }
              this.tokenByModel = [...mMap.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output));
            } else {
              this.tokenByModel = [];
            }

            // By Key (when key filter is All)
            if (!this.tokenFilterKey) {
              const kMap = new Map();
              for (const r of data) {
                const existing = kMap.get(r.keyId);
                if (existing) {
                  existing.requests += r.requests;
                  existing.input += r.inputTokens;
                  existing.output += r.outputTokens;
                } else {
                  kMap.set(r.keyId, { label: keyNameMap.get(r.keyId) || r.keyId.slice(0, 8), requests: r.requests, input: r.inputTokens, output: r.outputTokens });
                }
              }
              this.tokenByKey = [...kMap.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output));
            } else {
              this.tokenByKey = [];
            }

            // By Client (when client filter is All)
            if (!this.tokenFilterClient) {
              const cMap = new Map();
              for (const r of data) {
                const c = r.client || 'unknown';
                const existing = cMap.get(c);
                if (existing) {
                  existing.requests += r.requests;
                  existing.input += r.inputTokens;
                  existing.output += r.outputTokens;
                } else {
                  cMap.set(c, { label: c, requests: r.requests, input: r.inputTokens, output: r.outputTokens });
                }
              }
              this.tokenByClient = [...cMap.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output));
            } else {
              this.tokenByClient = [];
            }

            // By User (admin only, when user filter is All)
            if (this.isAdmin && !this.tokenFilterUser) {
              const uMap = new Map();
              for (const r of data) {
                const uid = r.ownerId || '_admin';
                const uname = r.ownerName || (uid === '_admin' ? 'Admin' : uid.slice(0, 8));
                const existing = uMap.get(uid);
                if (existing) {
                  existing.requests += r.requests;
                  existing.input += r.inputTokens;
                  existing.output += r.outputTokens;
                } else {
                  uMap.set(uid, { label: uname, requests: r.requests, input: r.inputTokens, output: r.outputTokens });
                }
              }
              this.tokenByUser = [...uMap.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output));
            } else {
              this.tokenByUser = [];
            }

            // Build time-series chart
            const bucketMap = new Map();
            const now = new Date();
            if (this.tokenRange === 'today') {
              for (let h = 0; h < 24; h++) {
                const d = new Date(now);
                d.setHours(h, 0, 0, 0);
                bucketMap.set(this.localHourKey(d), String(h).padStart(2, '0') + ':00 \\u2013 ' + String((h + 1) % 24).padStart(2, '0') + ':00');
              }
            } else if (this.tokenRange === 'week') {
              const ref = new Date(now);
              ref.setDate(ref.getDate() + this.tokenWeekOffset * 7);
              const day = ref.getDay();
              const monday = new Date(ref);
              monday.setDate(ref.getDate() - ((day + 6) % 7));
              monday.setHours(0, 0, 0, 0);
              const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
              for (let i = 0; i < 7; i++) {
                const d = new Date(monday);
                d.setDate(monday.getDate() + i);
                bucketMap.set(this.localDateKey(d), weekdays[i] + ' ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
              }
            } else {
              const days = this.tokenRange === '7d' ? 7 : 30;
              for (let i = days - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                d.setHours(0, 0, 0, 0);
                bucketMap.set(this.localDateKey(d), d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
              }
            }

            // Determine groupBy dimension for chart series
            // If exactly one dimension is "All", group by that dimension
            // If multiple are "All", group by first "All" dimension (user > key > client > model)
            // If none are "All", just show a single total line
            const allDims = [];
            if (this.isAdmin && !this.tokenFilterUser) allDims.push('user');
            if (!this.tokenFilterKey) allDims.push('key');
            if (!this.tokenFilterClient) allDims.push('client');
            if (!this.tokenFilterModel) allDims.push('model');

            let groupBy = allDims.length > 0 ? allDims[0] : 'total';

            const seriesMap = new Map();
            const agg = new Map();
            for (const [key] of bucketMap) agg.set(key, new Map());
            for (const r of data) {
              const utc = new Date(r.hour + ':00:00Z');
              const bucket = isDaily ? this.localDateKey(utc) : this.localHourKey(utc);
              if (!agg.has(bucket)) continue;
              let seriesKey;
              if (groupBy === 'user') {
                seriesKey = r.ownerId || '_admin';
                seriesMap.set(seriesKey, r.ownerName || (seriesKey === '_admin' ? 'Admin' : seriesKey.slice(0, 8)));
              } else if (groupBy === 'key') {
                seriesKey = r.keyId;
                seriesMap.set(r.keyId, keyNameMap.get(r.keyId) || r.keyId.slice(0, 8));
              } else if (groupBy === 'client') {
                seriesKey = r.client || 'unknown';
                seriesMap.set(seriesKey, seriesKey);
              } else if (groupBy === 'model') {
                seriesKey = r.model || 'unknown';
                seriesMap.set(seriesKey, seriesKey);
              } else {
                seriesKey = 'total';
                seriesMap.set('total', 'Total');
              }
              const m = agg.get(bucket);
              m.set(seriesKey, (m.get(seriesKey) || 0) + r.inputTokens + r.outputTokens);
            }

            const seriesList = [...seriesMap.keys()];
            const labels = [...bucketMap.values()];
            const bucketKeys = [...bucketMap.keys()];

            if (this.tokenChart) {
              try {
                this.tokenChart.stop();
                this.tokenChart.destroy();
              } catch { /* ignore destroy errors */ }
              this.tokenChart = null;
            }

            const _ptBg = _dark ? '#161922' : '#ffffff';
            const _fillAlpha = _dark ? '20' : '30';

            const datasets = seriesList.map((sk, i) => {
              const c = palette[i % palette.length];
              return {
                label: seriesMap.get(sk),
                data: bucketKeys.map((k) => agg.get(k)?.get(sk) || 0),
                borderColor: c,
                backgroundColor: c + _fillAlpha,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBorderWidth: 2,
                pointHoverBackgroundColor: _ptBg,
                pointHoverBorderColor: c,
                tension: 0.4,
                fill: true,
                borderCapStyle: 'round',
                borderJoinStyle: 'round',
              };
            });

            const _tc = getComputedStyle(document.documentElement);
            const _gridC = _tc.getPropertyValue('--grid-color').trim();
            const _tickC = _tc.getPropertyValue('--tick-color').trim();
            const _ttBg = _tc.getPropertyValue('--tooltip-bg').trim();
            const _ttBorder = _tc.getPropertyValue('--tooltip-border').trim();
            const _ttText = _tc.getPropertyValue('--tooltip-text').trim();
            const _ttText2 = _tc.getPropertyValue('--tooltip-text2').trim();

            try {
            this.tokenChart = new Chart(canvas, {
              type: 'line',
              data: { labels, datasets },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 400, easing: 'easeOutQuart' },
                interaction: { mode: 'index', intersect: false },
                plugins: {
                  legend: {
                    position: 'bottom',
                    labels: {
                      color: _tickC,
                      font: { size: 11, family: "'Outfit', sans-serif", weight: '400' },
                      boxWidth: 8,
                      boxHeight: 8,
                      padding: 20,
                      usePointStyle: true,
                      pointStyle: 'circle',
                    },
                  },
                  tooltip: {
                    backgroundColor: _ttBg,
                    borderColor: _ttBorder,
                    borderWidth: 1,
                    cornerRadius: 8,
                    titleColor: _ttText,
                    titleFont: { family: "'Outfit', sans-serif", size: 12, weight: '500' },
                    bodyColor: _ttText2,
                    bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
                    padding: { top: 10, bottom: 10, left: 14, right: 14 },
                    boxPadding: 6,
                    usePointStyle: true,
                    callbacks: {
                      label: (ctx) => ' ' + ctx.dataset.label + '  ' + ctx.parsed.y.toLocaleString() + ' tokens',
                    },
                  },
                },
                scales: {
                  x: {
                    grid: { display: false },
                    ticks: {
                      color: _tickC,
                      font: { size: 10, family: "'Outfit', sans-serif" },
                      maxRotation: 0,
                      padding: 8,
                    },
                    border: { display: false },
                  },
                  y: {
                    beginAtZero: true,
                    grid: { color: _gridC, lineWidth: 0.5, drawTicks: false },
                    ticks: {
                      color: _tickC,
                      font: { size: 10, family: "'IBM Plex Mono', monospace" },
                      padding: 12,
                      callback: (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v,
                    },
                    border: { display: false },
                  },
                },
              },
            });
            } catch(e) { /* chart creation can fail on double-init */ }
          },

          switchTokenRange(range) {
            this.tokenRange = range;
            if (range !== 'week') this.tokenWeekOffset = 0;
            this.loadTokenUsage();
          },

          shiftWeek(delta) {
            this.tokenWeekOffset += delta;
            if (this.tokenWeekOffset > 0) this.tokenWeekOffset = 0;
            this.loadTokenUsage();
          },

          weekLabel() {
            const now = new Date();
            const ref = new Date(now);
            ref.setDate(ref.getDate() + this.tokenWeekOffset * 7);
            const day = ref.getDay();
            const monday = new Date(ref);
            monday.setDate(ref.getDate() - ((day + 6) % 7));
            monday.setHours(0, 0, 0, 0);
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            if (this.tokenWeekOffset === 0) return 'This Week (' + fmt(monday) + ' – ' + fmt(sunday) + ')';
            if (this.tokenWeekOffset === -1) return 'Last Week (' + fmt(monday) + ' – ' + fmt(sunday) + ')';
            return fmt(monday) + ' – ' + fmt(sunday);
          },

          switchTokenFilter() {
            this.$nextTick().then(() => this.renderTokenChart());
          },

          distPercent(items, field) {
            const total = items.reduce((s, m) => s + m[field], 0);
            if (!total) return items.map(() => 0);
            return items.map((m) => Math.round(m[field] / total * 1000) / 10);
          },

          async fetchLatencyData() {
            this.latencyLoading = true;
            try {
              const now = new Date();
              let rangeStart, rangeEnd;
              if (this.latencyRange === 'week') {
                const ref = new Date(now);
                ref.setDate(ref.getDate() + this.latencyWeekOffset * 7);
                const day = ref.getDay();
                const monday = new Date(ref);
                monday.setDate(ref.getDate() - ((day + 6) % 7));
                monday.setHours(0, 0, 0, 0);
                const sunday = new Date(monday);
                sunday.setDate(monday.getDate() + 7);
                sunday.setHours(0, 0, 0, 0);
                rangeStart = monday;
                rangeEnd = sunday;
              } else {
                rangeStart = new Date(now);
                if (this.latencyRange === 'today') {
                  rangeStart.setHours(0, 0, 0, 0);
                } else if (this.latencyRange === '7d') {
                  rangeStart.setDate(rangeStart.getDate() - 6);
                  rangeStart.setHours(0, 0, 0, 0);
                } else {
                  rangeStart.setDate(rangeStart.getDate() - 29);
                  rangeStart.setHours(0, 0, 0, 0);
                }
                rangeEnd = new Date(now.getTime() + 3600000);
              }
              const start = rangeStart.toISOString().slice(0, 13);
              const end = rangeEnd.toISOString().slice(0, 13);
              const resp = await fetch('/api/latency?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end), { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) this.latencyData = await resp.json();
            } catch (e) {
              console.error('fetchLatencyData:', e);
            } finally {
              this.latencyLoading = false;
            }
          },

          async loadLatencyData() {
            await this.fetchLatencyData();
            if (this.tab !== 'latency') return;
            await this.$nextTick();
            this.renderLatencyChart();
          },

          renderLatencyChart() {
            const canvas = document.getElementById('latencyChart');
            if (!canvas || canvas.clientWidth === 0 || !canvas.getContext) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            const isDaily = this.latencyRange !== 'today';
            const allData = this.latencyData;

            // Extract unique models for the filter dropdown
            const modelSet = new Set();
            for (const r of allData) if (r.model) modelSet.add(r.model);
            this.latencyModels = [...modelSet].sort();

            // Filter by selected model
            const data = this.latencyModel ? allData.filter((r) => r.model === this.latencyModel) : allData;

            // Compute summary
            let totalReqs = 0, sumTotal = 0, sumUpstream = 0, sumTtfb = 0, sumMiss = 0;
            for (const r of data) {
              totalReqs += r.requests;
              sumTotal += r.totalMs;
              sumUpstream += r.upstreamMs;
              sumTtfb += r.ttfbMs;
              sumMiss += r.tokenMiss;
            }
            this.latencySummary = {
              avgTotal: totalReqs > 0 ? Math.round(sumTotal / totalReqs) : 0,
              avgUpstream: totalReqs > 0 ? Math.round(sumUpstream / totalReqs) : 0,
              avgTtfb: totalReqs > 0 ? Math.round(sumTtfb / totalReqs) : 0,
              tokenMissRate: totalReqs > 0 ? Math.round((sumMiss / totalReqs) * 100) : 0,
            };

            // Compute by-type breakdown (stream vs sync)
            const typeMap = new Map();
            for (const r of data) {
              const key = r.stream ? 'Stream' : 'Sync';
              if (!typeMap.has(key)) typeMap.set(key, { requests: 0, totalMs: 0, upstreamMs: 0, ttfbMs: 0, tokenMiss: 0 });
              const t = typeMap.get(key);
              t.requests += r.requests;
              t.totalMs += r.totalMs;
              t.upstreamMs += r.upstreamMs;
              t.ttfbMs += r.ttfbMs;
              t.tokenMiss += r.tokenMiss;
            }
            this.latencyByType = [...typeMap.entries()]
              .map(([type, v]) => ({
                type,
                requests: v.requests,
                avgTotal: v.requests > 0 ? Math.round(v.totalMs / v.requests) : 0,
                avgUpstream: v.requests > 0 ? Math.round(v.upstreamMs / v.requests) : 0,
                avgTtfb: v.requests > 0 ? Math.round(v.ttfbMs / v.requests) : 0,
                tokenMissRate: v.requests > 0 ? Math.round((v.tokenMiss / v.requests) * 100) : 0,
              }))
              .sort((a, b) => b.requests - a.requests);

            // Compute by-colo breakdown
            const coloMap = new Map();
            for (const r of data) {
              if (!coloMap.has(r.colo)) coloMap.set(r.colo, { requests: 0, totalMs: 0, upstreamMs: 0, tokenMiss: 0 });
              const c = coloMap.get(r.colo);
              c.requests += r.requests;
              c.totalMs += r.totalMs;
              c.upstreamMs += r.upstreamMs;
              c.tokenMiss += r.tokenMiss;
            }
            this.latencyByColo = [...coloMap.entries()]
              .map(([colo, v]) => ({
                colo,
                requests: v.requests,
                avgTotal: v.requests > 0 ? Math.round(v.totalMs / v.requests) : 0,
                avgUpstream: v.requests > 0 ? Math.round(v.upstreamMs / v.requests) : 0,
                tokenMissRate: v.requests > 0 ? Math.round((v.tokenMiss / v.requests) * 100) : 0,
              }))
              .sort((a, b) => b.requests - a.requests);

            // Build time buckets
            const bucketMap = new Map();
            const now = new Date();
            if (this.latencyRange === 'today') {
              for (let h = 0; h < 24; h++) {
                const d = new Date(now);
                d.setHours(h, 0, 0, 0);
                bucketMap.set(this.localHourKey(d), String(h).padStart(2, '0') + ':00');
              }
            } else if (this.latencyRange === 'week') {
              const ref = new Date(now);
              ref.setDate(ref.getDate() + this.latencyWeekOffset * 7);
              const day = ref.getDay();
              const monday = new Date(ref);
              monday.setDate(ref.getDate() - ((day + 6) % 7));
              monday.setHours(0, 0, 0, 0);
              const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
              for (let i = 0; i < 7; i++) {
                const d = new Date(monday);
                d.setDate(monday.getDate() + i);
                bucketMap.set(this.localDateKey(d), weekdays[i] + ' ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
              }
            } else {
              const days = this.latencyRange === '7d' ? 7 : 30;
              for (let i = days - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                d.setHours(0, 0, 0, 0);
                bucketMap.set(this.localDateKey(d), d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
              }
            }

            // Aggregate per bucket per type (stream/sync): avg total latency
            const aggStream = new Map();
            const aggSync = new Map();
            const reqsStream = new Map();
            const reqsSync = new Map();
            for (const [key] of bucketMap) {
              aggStream.set(key, 0); aggSync.set(key, 0);
              reqsStream.set(key, 0); reqsSync.set(key, 0);
            }
            for (const r of data) {
              const utc = new Date(r.hour + ':00:00Z');
              const bucket = isDaily ? this.localDateKey(utc) : this.localHourKey(utc);
              if (!aggStream.has(bucket)) continue;
              if (r.stream) {
                reqsStream.set(bucket, reqsStream.get(bucket) + r.requests);
                aggStream.set(bucket, aggStream.get(bucket) + r.totalMs);
              } else {
                reqsSync.set(bucket, reqsSync.get(bucket) + r.requests);
                aggSync.set(bucket, aggSync.get(bucket) + r.totalMs);
              }
            }

            const labels = [...bucketMap.values()];
            const bucketKeys = [...bucketMap.keys()];
            const avg = (sum, reqs) => reqs > 0 ? Math.round(sum / reqs) : 0;

            const _lDark = isDarkTheme();
            const _streamC = _lDark ? '#7B90FF' : '#4E6CF5';
            const _syncC = _lDark ? '#50D48A' : '#2CA87A';
            const _lFillAlpha = _lDark ? '20' : '30';

            if (this.latencyChart) {
              this.latencyChart.stop();
              this.latencyChart.destroy();
              this.latencyChart = null;
            }

            const _lPtBg = _lDark ? '#161922' : '#ffffff';

            const datasets = [
              {
                label: 'Stream',
                data: bucketKeys.map((k) => avg(aggStream.get(k), reqsStream.get(k))),
                borderColor: _streamC,
                backgroundColor: _streamC + _lFillAlpha,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBorderWidth: 2,
                pointHoverBackgroundColor: _lPtBg,
                pointHoverBorderColor: _streamC,
                tension: 0.4,
                fill: true,
                borderCapStyle: 'round',
                borderJoinStyle: 'round',
              },
              {
                label: 'Sync',
                data: bucketKeys.map((k) => avg(aggSync.get(k), reqsSync.get(k))),
                borderColor: _syncC,
                backgroundColor: _syncC + _lFillAlpha,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBorderWidth: 2,
                pointHoverBackgroundColor: _lPtBg,
                pointHoverBorderColor: _syncC,
                tension: 0.4,
                fill: true,
                borderCapStyle: 'round',
                borderJoinStyle: 'round',
              },
            ];

            const _lc = getComputedStyle(document.documentElement);
            const _lGridC = _lc.getPropertyValue('--grid-color').trim();
            const _lTickC = _lc.getPropertyValue('--tick-color').trim();
            const _lTtBg = _lc.getPropertyValue('--tooltip-bg').trim();
            const _lTtBorder = _lc.getPropertyValue('--tooltip-border').trim();
            const _lTtText = _lc.getPropertyValue('--tooltip-text').trim();
            const _lTtText2 = _lc.getPropertyValue('--tooltip-text2').trim();

            this.latencyChart = new Chart(canvas, {
              type: 'line',
              data: { labels, datasets },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 400, easing: 'easeOutQuart' },
                interaction: { mode: 'index', intersect: false },
                plugins: {
                  legend: {
                    position: 'bottom',
                    labels: {
                      color: _lTickC,
                      font: { size: 11, family: "'Outfit', sans-serif", weight: '400' },
                      boxWidth: 8,
                      boxHeight: 8,
                      padding: 20,
                      usePointStyle: true,
                      pointStyle: 'circle',
                    },
                  },
                  tooltip: {
                    backgroundColor: _lTtBg,
                    borderColor: _lTtBorder,
                    borderWidth: 1,
                    cornerRadius: 8,
                    titleColor: _lTtText,
                    titleFont: { family: "'Outfit', sans-serif", size: 12, weight: '500' },
                    bodyColor: _lTtText2,
                    bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
                    padding: { top: 10, bottom: 10, left: 14, right: 14 },
                    boxPadding: 6,
                    usePointStyle: true,
                    callbacks: {
                      label: (ctx) => ' ' + ctx.dataset.label + '  ' + ctx.parsed.y.toLocaleString() + ' ms',
                    },
                  },
                },
                scales: {
                  x: {
                    grid: { display: false },
                    ticks: {
                      color: _lTickC,
                      font: { size: 10, family: "'Outfit', sans-serif" },
                      maxRotation: 0,
                      padding: 8,
                    },
                    border: { display: false },
                  },
                  y: {
                    beginAtZero: true,
                    grid: { color: _lGridC, lineWidth: 0.5, drawTicks: false },
                    ticks: {
                      color: _lTickC,
                      font: { size: 10, family: "'IBM Plex Mono', monospace" },
                      padding: 12,
                      callback: (v) => v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms',
                    },
                    border: { display: false },
                  },
                },
              },
            });
          },

          switchLatencyRange(range) {
            this.latencyRange = range;
            if (range !== 'week') this.latencyWeekOffset = 0;
            this.loadLatencyData();
          },

          shiftLatencyWeek(delta) {
            this.latencyWeekOffset += delta;
            if (this.latencyWeekOffset > 0) this.latencyWeekOffset = 0;
            this.loadLatencyData();
          },

          latencyWeekLabel() {
            const now = new Date();
            const ref = new Date(now);
            ref.setDate(ref.getDate() + this.latencyWeekOffset * 7);
            const day = ref.getDay();
            const monday = new Date(ref);
            monday.setDate(ref.getDate() - ((day + 6) % 7));
            monday.setHours(0, 0, 0, 0);
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            if (this.latencyWeekOffset === 0) return 'This Week (' + fmt(monday) + ' – ' + fmt(sunday) + ')';
            if (this.latencyWeekOffset === -1) return 'Last Week (' + fmt(monday) + ' – ' + fmt(sunday) + ')';
            return fmt(monday) + ' – ' + fmt(sunday);
          },

          switchLatencyModel(model) {
            this.latencyModel = model;
            this.$nextTick().then(() => this.renderLatencyChart());
          },

          async exportData() {
            this.exportLoading = true;
            try {
              const resp = await fetch('/api/export', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (!resp.ok) {
                alert('Export failed: ' + (await resp.json()).error);
                return;
              }
              const data = await resp.json();
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'copilot-export-' + new Date().toISOString().slice(0, 10) + '.json';
              a.click();
              URL.revokeObjectURL(url);
            } catch (e) {
              console.error('exportData:', e);
              alert('Export failed');
            } finally {
              this.exportLoading = false;
            }
          },

          handleImportFile(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.importFile = file;
            this.importPreview = { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0 };
            this.importData = null;

            const reader = new FileReader();
            reader.onload = (e) => {
              try {
                const json = JSON.parse(e.target.result);
                if (!json.data) {
                  alert('Invalid export file: missing data field');
                  this.importFile = null;
                  return;
                }
                this.importData = json.data;
                this.importPreview = {
                  ready: true,
                  exportedAt: json.exportedAt || null,
                  apiKeys: Array.isArray(json.data.apiKeys) ? json.data.apiKeys.length : 0,
                  githubAccounts: Array.isArray(json.data.githubAccounts) ? json.data.githubAccounts.length : 0,
                  usage: Array.isArray(json.data.usage) ? json.data.usage.length : 0,
                };
              } catch {
                alert('Invalid JSON file');
                this.importFile = null;
              }
            };
            reader.readAsText(file);
          },

          async doImport() {
            if (!this.importData) return;
            if (this.importMode === 'replace') {
              if (!confirm('This will DELETE ALL existing data and replace it with the imported file. Are you sure?')) return;
            }
            this.importLoading = true;
            try {
              const resp = await fetch('/api/import', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: this.importMode, data: this.importData }),
              });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              const result = await resp.json();
              if (resp.ok) {
                alert('Import complete: ' + result.imported.apiKeys + ' keys, ' + result.imported.githubAccounts + ' accounts, ' + result.imported.usage + ' usage records');
                this.importFile = null;
                this.importData = null;
                this.importPreview = { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0 };
              } else {
                alert('Import failed: ' + (result.error || 'Unknown error'));
              }
            } catch (e) {
              console.error('doImport:', e);
              alert('Import failed');
            } finally {
              this.importLoading = false;
            }
          },

          // === Admin: Invite Codes ===
          async loadInviteCodes() {
            this.inviteCodesLoading = true;
            try {
              const resp = await fetch('/auth/admin/invite-codes', { headers: this.authHeaders() });
              if (resp.ok) this.inviteCodes = await resp.json();
            } catch (e) {
              console.error('loadInviteCodes:', e);
            } finally {
              this.inviteCodesLoading = false;
            }
          },

          async createInviteCode() {
            const name = this.newInviteName.trim();
            if (!name) return;
            this.inviteCreating = true;
            try {
              const resp = await fetch('/auth/admin/invite-codes', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
              });
              if (resp.ok) {
                this.newInviteName = '';
                await this.loadInviteCodes();
              } else {
                alert((await resp.json()).error || 'Failed');
              }
            } catch (e) {
              console.error('createInviteCode:', e);
            } finally {
              this.inviteCreating = false;
            }
          },

          async deleteInviteCode(id) {
            if (!confirm('Delete this invite code?')) return;
            try {
              await fetch('/auth/admin/invite-codes/' + id, { method: 'DELETE', headers: this.authHeaders() });
              await this.loadInviteCodes();
            } catch (e) {
              console.error('deleteInviteCode:', e);
            }
          },

          // === Admin: User Management ===
          async loadAdminUsers() {
            this.adminUsersLoading = true;
            try {
              const resp = await fetch('/auth/admin/users', { headers: this.authHeaders() });
              if (resp.ok) this.adminUsers = await resp.json();
            } catch (e) {
              console.error('loadAdminUsers:', e);
            } finally {
              this.adminUsersLoading = false;
            }
          },

          async toggleUser(id, disabled) {
            const action = disabled ? 'enable' : 'disable';
            try {
              await fetch('/auth/admin/users/' + id + '/' + action, { method: 'POST', headers: this.authHeaders() });
              await this.loadAdminUsers();
            } catch (e) {
              console.error('toggleUser:', e);
            }
          },

          async deleteUser(id, name) {
            if (!confirm('Delete user "' + name + '"? All their API keys, GitHub accounts, and sessions will be removed.')) return;
            try {
              await fetch('/auth/admin/users/' + id, { method: 'DELETE', headers: this.authHeaders() });
              await this.loadAdminUsers();
            } catch (e) {
              console.error('deleteUser:', e);
            }
          },

          logout() {
            localStorage.removeItem('authKey');
            localStorage.removeItem('isAdmin');
            localStorage.removeItem('isUser');
            localStorage.removeItem('userId');
            localStorage.removeItem('userName');
            localStorage.removeItem('login_key_id');
            localStorage.removeItem('login_key_name');
            localStorage.removeItem('login_key_hint');
            window.location.href = '/';
          },

          kickToLogin() {
            this.logout();
          },
        };
      }
    </script>
  `
}
