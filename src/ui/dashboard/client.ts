// Dashboard Alpine.js client-side JavaScript
export function dashboardAssets(): string {
  return `
    <style>
    select option { background: var(--surface-800); color: var(--text-primary); }

    /* Toast notification */
    .toast-container {
      position: fixed; top: 24px; right: 24px; z-index: 9999;
      display: flex; flex-direction: column; gap: 8px;
    }
    .toast {
      padding: 12px 20px; border-radius: 8px; font-size: 13px;
      font-family: 'Outfit', sans-serif; color: #fff;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      animation: toast-in 0.3s ease-out;
      max-width: 360px;
    }
    .toast-error { background: #dc3545; }
    .toast-warning { background: #e67e22; }
    .toast-info { background: #3b82f6; }
    @keyframes toast-in { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: translateY(0); } }
    </style>

    <div class="toast-container" id="toastContainer"></div>

    <script>
    function getCookie(name) {
      const m = document.cookie.match('(?:^|;\\\\s*)' + name + '=([^;]*)');
      return m ? decodeURIComponent(m[1]) : '';
    }

    function getUserAvatar() {
      return getCookie('user_avatar') || localStorage.getItem('userAvatar') || '';
    }

    function showToast(message, type) {
      type = type || 'error';
      const container = document.getElementById('toastContainer');
      if (!container) return;
      const el = document.createElement('div');
      el.className = 'toast toast-' + type;
      el.textContent = message;
      container.appendChild(el);
      setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
    }

    function dashboardApp() {
    const isAdmin = localStorage.getItem('isAdmin') === '1';
    const isUser = localStorage.getItem('isUser') === '1';
    const TABS = isAdmin ? ['upstream', 'users', 'keys', 'usage', 'latency', 'relays', 'settings'] : (isUser ? ['upstream', 'keys', 'usage', 'latency', 'relays'] : ['keys', 'usage', 'latency']);
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

    // Safely destroy a Chart.js instance by replacing the canvas element first.
    // This prevents the "Cannot read properties of null (reading 'save')" error
    // caused by Chart.js animation frames firing after destroy() nullifies ctx.
    function safeChartDestroy(chart, canvasId) {
      if (!chart) return;
      try { chart.stop(); } catch {}
      const canvas = document.getElementById(canvasId);
      if (canvas && canvas.parentElement) {
        const fresh = document.createElement('canvas');
        fresh.id = canvasId;
        canvas.parentElement.replaceChild(fresh, canvas);
      }
      setTimeout(() => { try { chart.destroy(); } catch {} }, 0);
    }

    function computeTimeRange(range, weekOffset) {
      const now = new Date();
      let start, end;
      if (range === 'week') {
        // Local week (Mon..Sun) so the time axis matches local time
        const ref = new Date(now);
        ref.setDate(ref.getDate() + weekOffset * 7);
        const day = ref.getDay(); // 0 = Sunday
        const monday = new Date(ref);
        monday.setDate(ref.getDate() - ((day + 6) % 7));
        monday.setHours(0, 0, 0, 0);
        start = monday;
        end = new Date(monday.getTime() + 7 * 86400000);
      } else {
        // Local midnight for today / rolling windows
        const todayLocal = new Date(now);
        todayLocal.setHours(0, 0, 0, 0);
        if (range === 'today') {
          start = todayLocal;
        } else if (range === '7d') {
          start = new Date(todayLocal.getTime() - 6 * 86400000);
        } else {
          start = new Date(todayLocal.getTime() - 29 * 86400000);
        }
        end = new Date(now.getTime() + 3600000);
      }
      return {
        start: start.toISOString().slice(0, 13),
        end: end.toISOString().slice(0, 13),
      };
    }

    function formatWeekLabel(weekOffset) {
      const now = new Date();
      const ref = new Date(now);
      ref.setDate(ref.getDate() + weekOffset * 7);
      const day = ref.getDay(); // 0 = Sunday
      const monday = new Date(ref);
      monday.setDate(ref.getDate() - ((day + 6) % 7));
      monday.setHours(0, 0, 0, 0);
      const sunday = new Date(monday.getTime() + 6 * 86400000);
      const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (weekOffset === 0) return t('dash.thisWeek') + ' (' + fmt(monday) + ' \u2013 ' + fmt(sunday) + ')';
      if (weekOffset === -1) return t('dash.lastWeek') + ' (' + fmt(monday) + ' \u2013 ' + fmt(sunday) + ')';
      return fmt(monday) + ' \u2013 ' + fmt(sunday);
    }

    function buildDistribution(data, keyFn, labelFn) {
      const m = new Map();
      for (const r of data) {
        const k = keyFn(r);
        const existing = m.get(k);
        const cr = r.cacheReadTokens || 0;
        const cc = r.cacheCreationTokens || 0;
        if (existing) {
          existing.requests += r.requests;
          existing.input += r.inputTokens;
          existing.output += r.outputTokens;
          existing.cacheRead += cr;
          existing.cacheCreation += cc;
        } else {
          m.set(k, {
            label: labelFn(r, k),
            requests: r.requests,
            input: r.inputTokens,
            output: r.outputTokens,
            cacheRead: cr,
            cacheCreation: cc,
          });
        }
      }
      // Sort by full total (incl. cache) so distribution row order matches the
      // headline card, which also sums all four buckets.
      return [...m.values()].sort((a, b) => {
        const totA = a.input + a.output + a.cacheRead + a.cacheCreation;
        const totB = b.input + b.output + b.cacheRead + b.cacheCreation;
        return totB - totA;
      });
    }

    function chartBaseOptions(labelCallback) {
      const dark = isDarkTheme();
      const cs = getComputedStyle(document.documentElement);
      const gridC = cs.getPropertyValue('--grid-color').trim();
      const tickC = cs.getPropertyValue('--tick-color').trim();
      const ttBg = cs.getPropertyValue('--tooltip-bg').trim();
      const ttBorder = cs.getPropertyValue('--tooltip-border').trim();
      const ttText = cs.getPropertyValue('--tooltip-text').trim();
      const ttText2 = cs.getPropertyValue('--tooltip-text2').trim();
      const ptBg = dark ? '#161922' : '#ffffff';
      const fillAlpha = dark ? '20' : '30';
      return {
        ptBg, fillAlpha,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 400, easing: 'easeOutQuart' },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              position: 'bottom',
              labels: {
                color: tickC,
                font: { size: 11, family: "'Outfit', sans-serif", weight: '400' },
                boxWidth: 8, boxHeight: 8, padding: 20,
                usePointStyle: true, pointStyle: 'circle',
              },
            },
            tooltip: {
              backgroundColor: ttBg, borderColor: ttBorder, borderWidth: 1, cornerRadius: 8,
              titleColor: ttText,
              titleFont: { family: "'Outfit', sans-serif", size: 12, weight: '500' },
              bodyColor: ttText2,
              bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
              padding: { top: 10, bottom: 10, left: 14, right: 14 },
              boxPadding: 6, usePointStyle: true,
              callbacks: { label: labelCallback },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: tickC, font: { size: 10, family: "'Outfit', sans-serif" }, maxRotation: 0, padding: 8 },
              border: { display: false },
            },
            y: {
              beginAtZero: true,
              grid: { color: gridC, lineWidth: 0.5, drawTicks: false },
              ticks: { color: tickC, font: { size: 10, family: "'IBM Plex Mono', monospace" }, padding: 12 },
              border: { display: false },
            },
          },
        },
      };
    }

    return {
      authKey: '',
      isAdmin,
      isUser,
      userId: localStorage.getItem('userId') || '',
      tab: initTab,
      // — Shared Observability (spec §3.1) —
      viewAs: null,            // null = self; else ownerId being viewed
      sharedToMe: [],          // [{ ownerId, ownerEmail, ownerName }]
      sharedByMe: [],          // [{ viewerId, viewerEmail, viewerName, grantedAt }]
      mySharingOpen: false,    // controls "My Sharing" modal visibility
      mySharingEmail: '',      // email input in modal
      mySharingError: '',      // error string under input
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
      shareEmail: '',
      shareError: '',
      sharing: false,
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
      tokenMetric: 'tokens',    // 'tokens' | 'requests'
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
      githubQuotas: {},
      githubQuotaInflight: 0,
      inviteCodes: [],
      inviteCodesLoading: false,
      newInviteName: '',
      inviteCreating: false,

      // Quota
      quotaEditing: false,
      quotaSaving: false,
      quotaEditReq: null,
      quotaEditToken: null,
      quotaUsageData: [],     // today's usage records for selected key
      selectedKeyQuota: { reqLimit: null, reqUsed: 0, reqPercent: 0, tokenLimit: null, tokenUsed: 0, tokenPercent: 0 },

      // Web Search
      wsEditing: false,
      wsSaving: false,
      wsEditEnabled: false,
      wsEditPriority: ['msGrounding', 'langsearch', 'tavily', 'bing', 'copilot'],
      wsEditLangsearch: '',
      wsEditTavily: '',
      wsEditMsGrounding: '',
      wsEditLangsearchReplacing: false,
      wsEditTavilyReplacing: false,
      wsEditMsGroundingReplacing: false,
      wsEditLangsearchRef: '',
      wsEditTavilyRef: '',
      wsEditMsGroundingRef: '',
      wsCopySourceId: '',
      borrowPickerEngine: '',
      wsConfig: { enabled: false, langsearchKey: null, tavilyKey: null, msGroundingKey: null, langsearchRef: null, tavilyRef: null, msGroundingRef: null },
      wsUsage: { searches: 0, successes: 0, failures: 0, engines: [], range: '1d' },
      wsUsageRange: '1d',

      // Relays tab
      relays: [],
      relaysLoading: false,
      relaysRefreshInterval: null,

      // Change-password modal
      hasPassword: false,
      changePasswordOpen: false,
      cpOldPassword: '',
      cpNewPassword: '',
      cpConfirmPassword: '',
      cpError: '',
      cpSubmitting: false,

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
        if (seconds < 60) return t('dash.timeJustNow');
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return t(minutes === 1 ? 'dash.timeMinuteAgo' : 'dash.timeMinutesAgo', { n: minutes });
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return t(hours === 1 ? 'dash.timeHourAgo' : 'dash.timeHoursAgo', { n: hours });
        const days = Math.floor(hours / 24);
        if (days <= 30) return t(days === 1 ? 'dash.timeDayAgo' : 'dash.timeDaysAgo', { n: days });
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
            '# DEPRECATED: GEMINI_API_BASE_URL was renamed to GOOGLE_GEMINI_BASE_URL in gemini-cli v0.13.0+',
            '# ref: https://github.com/google-gemini/gemini-cli/blob/3bc56d0ef55050c29d8479eeb81b4e273b8101c8/docs/changelogs/preview.md',
            'export GEMINI_API_BASE_URL=' + this.baseUrl,
            'export GOOGLE_GEMINI_BASE_URL=' + this.baseUrl,
            'export GEMINI_MODEL=' + this.geminiModel,
          ];
          return lines.join('\\n');
        },

        init() {
          if (this._initialized) return;

          // Cookie-based auth: check session via /auth/login
          this._initialized = true;
          this.checkSession();
        },

        // Spec §3.1 — observability paths only. NEVER use this for writes,
        // /auth/me, /api/keys, or /api/observability-shares. Helper choice
        // is the security boundary; there is no central allowlist guard.
        async observabilityFetch(path, opts = {}) {
          const url = new URL(path, location.origin)
          if (this.viewAs) url.searchParams.set('as_user', this.viewAs)
          const r = await fetch(url, opts)
          if (this.viewAs && r.status === 403) {
            await this.fallBackToSelfFromShared('forbidden')
          }
          return r
        },

        // Spec §3.1.2 — context switch.
        async switchViewAs(ownerId) {
          this.viewAs = ownerId || null
          if (this.viewAs) {
            localStorage.setItem('viewAs', this.viewAs)
            this.keys = []                    // drop stale owner key state
            if (this.tab === 'keys') {
              this.tab = 'usage'
              location.hash = 'usage'
            }
          } else {
            localStorage.removeItem('viewAs')
            await this.loadKeys()             // restore self keys exactly once
          }
          await this.refreshAll()
        },

        // Spec §3.5 — auto-fall-back when grant has been revoked mid-session.
        async fallBackToSelfFromShared(reason) {
          this.viewAs = null
          localStorage.removeItem('viewAs')
          if (typeof showToast === 'function') {
            showToast(t('dash.sharedObsRevokedToast') || 'Access revoked', 'warning')
          }
          await this.loadKeys()
          await this.refreshAll()
        },

        // Spec §3.1.1 — load grants where current user is the viewer.
        async loadSharedToMe() {
          try {
            const r = await fetch('/api/observability-shares/granted-to-me', { credentials: 'same-origin' })
            if (!r.ok) { this.sharedToMe = []; return }
            this.sharedToMe = await r.json()
          } catch (e) {
            console.error('loadSharedToMe:', e)
            this.sharedToMe = []
          }
        },

        // Spec §3.3 — load grants where current user is the owner.
        async loadSharedByMe() {
          try {
            const r = await fetch('/api/observability-shares/granted-by-me', { credentials: 'same-origin' })
            if (!r.ok) { this.sharedByMe = []; return }
            this.sharedByMe = await r.json()
          } catch (e) {
            console.error('loadSharedByMe:', e)
            this.sharedByMe = []
          }
        },

        // Modal helpers — share-management writes use plain fetch, never observabilityFetch.
        async addMySharing() {
          this.mySharingError = ''
          const email = (this.mySharingEmail || '').trim().toLowerCase()
          if (!email) { this.mySharingError = t('dash.sharedObsAddPlaceholder'); return }
          try {
            const r = await fetch('/api/observability-shares', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ viewerEmail: email }),
            })
            if (r.status === 404) { this.mySharingError = t('dash.sharedObsNotFound') || 'No user with that email'; return }
            if (r.status === 400) { this.mySharingError = t('dash.sharedObsCannotSelf') || 'Cannot share with yourself'; return }
            if (!r.ok)            { this.mySharingError = 'Failed: ' + r.status; return }
            this.mySharingEmail = ''
            await this.loadSharedByMe()
          } catch (e) { this.mySharingError = String(e) }
        },

        async revokeMySharing(viewerId) {
          try {
            const r = await fetch('/api/observability-shares/' + encodeURIComponent(viewerId), { method: 'DELETE', credentials: 'same-origin' })
            if (!r.ok) return
            await this.loadSharedByMe()
          } catch (e) { console.error('revokeMySharing:', e) }
        },

        async refreshAll() {
          // Re-trigger every observability panel that the current tab owns.
          // Implementations of these methods are existing; we only re-call them
          // — they will route through observabilityFetch where applicable.
          try { await this.loadUsage?.() } catch {}
          try { await this.loadTokenUsage?.() } catch {}
          try { await this.loadLatencyData?.() } catch {}
          try { await this.loadRelays?.() } catch {}
          try { await this.loadUpstreamAccounts?.() } catch {}
        },


        async checkSession() {
          try {
            const resp = await fetch('/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
              credentials: 'same-origin',
            });
            if (resp.status === 401) {
              window.location.href = '/';
              return;
            }
            const data = await resp.json();
            if (!data.ok) {
              window.location.href = '/';
              return;
            }
            // Check if role changed since page load — if so, reload to recompute TABS
            const prevAdmin = localStorage.getItem('isAdmin') === '1';
            const prevUser = localStorage.getItem('isUser') === '1';
            // Update local state from session data
            this.isAdmin = !!data.isAdmin;
            this.isUser = !!data.isUser;
            this.hasPassword = !!data.hasPassword;
            localStorage.setItem('isAdmin', data.isAdmin ? '1' : '0');
            localStorage.setItem('isUser', data.isUser ? '1' : '0');
            if (data.userId) localStorage.setItem('userId', data.userId);
            if (data.userName) localStorage.setItem('userName', data.userName);
            if (data.email) localStorage.setItem('userEmail', data.email);
            if (data.avatarUrl) localStorage.setItem('userAvatar', data.avatarUrl);
            if (prevAdmin !== !!data.isAdmin || prevUser !== !!data.isUser) {
              window.location.reload();
              return;
            }
          } catch {
            window.location.href = '/';
            return;
          }

          this.loadModels();

          // Spec §3.1.1 — view-as boot sequence
          await this.loadSharedToMe();
          const stored = localStorage.getItem('viewAs');
          if (stored && this.sharedToMe.some(s => s.ownerId === stored)) {
            this.viewAs = stored;
          } else {
            this.viewAs = null;
            if (stored) localStorage.removeItem('viewAs');
          }
          if (this.viewAs && this.tab === 'keys') {
            this.tab = 'usage';
            location.hash = 'usage';
          }
          // Spec §3.3 — owner-side share list (used by My Sharing modal)
          await this.loadSharedByMe();

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
                this.$nextTick().then(() => { if (this.tab === 'usage') this.renderTokenChart(); });
              }
            }).catch(() => {});
          } else if (this.tab === 'latency') {
            this.latencyLoading = true;
            this.fetchLatencyData().then(() => {
              if (this.tab === 'latency') {
                this.$nextTick().then(() => { if (this.tab === 'latency') this.renderLatencyChart(); });
              }
            });
          } else if (this.tab === 'relays' && (this.isAdmin || this.isUser)) {
            this.loadRelays();
          }

          setInterval(() => {
            if (this.tab === 'upstream' && (this.isAdmin || this.isUser)) this.loadUsage();
            if (this.tab === 'usage') this.loadTokenUsage();
            if (this.tab === 'latency') this.loadLatencyData();
            if (this.tab === 'keys' && this.selectedKeyId) this.loadQuotaUsage(this.selectedKeyId);
            if (this.tab === 'relays' && (this.isAdmin || this.isUser)) this.loadRelays();
          }, 60000);

          setInterval(() => {
            this.now = Date.now();
          }, 30000);

          window.addEventListener('hashchange', () => {
            const h = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultTab;
            // Spec §3.5 — Keys tab is forbidden in shared mode
            if (this.viewAs && h === 'keys') {
              this.tab = 'usage';
              location.hash = 'usage';
              return;
            }
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

          this.$watch('selectedKeyId', (val) => {
            this.quotaEditing = false;
            this.wsEditing = false;
            if (val && this.tab === 'keys') {
              this.loadQuotaUsage(val);
              this.loadWebSearchConfig(val);
            }
          });
        },

        authHeaders() { return {}; },

        _switchId: 0,

        async switchTab(t) {
          // Spec §3.5 — switchTab('keys') is a no-op while viewing another user
          if (this.viewAs && t === 'keys') return;
          const switchId = ++this._switchId;

          if (t !== 'usage' && this.tokenChart) {
            safeChartDestroy(this.tokenChart, 'tokenChart');
            this.tokenChart = null;
          }
          if (t !== 'latency' && this.latencyChart) {
            safeChartDestroy(this.latencyChart, 'latencyChart');
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
            if (this._switchId !== switchId) return;
            await this.$nextTick();
            if (this._switchId !== switchId) return;
            this.renderTokenChart();
          } else if (t === 'latency') {
            this.latencyLoading = true;
            await this.fetchLatencyData();
            if (this._switchId !== switchId) return;
            await this.$nextTick();
            if (this._switchId !== switchId) return;
            this.renderLatencyChart();
          } else if (t === 'keys') {
            await this.loadKeys();
            if (this.selectedKeyId) {
              this.loadQuotaUsage(this.selectedKeyId);
              this.loadWebSearchConfig(this.selectedKeyId);
            }
          } else if (t === 'relays') {
            await this.loadRelays();
          }
        },

        async loadModels(retries) {
          retries = retries || 0;
          try {
            const resp = await fetch('/api/models', { credentials: 'same-origin' });
            if (!resp.ok) throw new Error('models fetch failed: ' + resp.status);
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
          } catch (e) {
            console.error('loadModels:', e);
            if (retries < 2) {
              setTimeout(() => this.loadModels(retries + 1), 2000 * (retries + 1));
            }
          }
        },

          async loadMe() {
            try {
              const resp = await fetch('/auth/me', { credentials: 'same-origin' });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
                return;
              }
              if (!resp.ok) {
                throw new Error('loadMe failed: ' + resp.status);
              }
              const data = await resp.json();
              this.githubConnected = data.github_connected;
              // Accounts list moved to /api/upstream-accounts (honors as_user)
              if (this.githubConnected) {
                try {
                  const acctResp = await this.observabilityFetch('/api/upstream-accounts', { credentials: 'same-origin' });
                  this.githubAccounts = acctResp.ok ? (await acctResp.json()) : [];
                } catch {
                  this.githubAccounts = [];
                }
              } else {
                this.githubAccounts = [];
              }
              this.meLoaded = true;
              // Spec §3.5 — if signed out / identity lost, drop viewAs
              if (!this.userId && this.viewAs) {
                this.viewAs = null;
                localStorage.removeItem('viewAs');
              }
            } catch (e) {
              console.error('loadMe:', e);
              // Don't set meLoaded = true on failure, so switchTab can retry
            }
          },

          async loadUsage() {
            try {
              const resp = await this.observabilityFetch('/api/copilot-quota', { credentials: 'same-origin' });
              if (resp.status === 401) {
                // GitHub token expired, not auth issue — don't kick to login
                this.usageError = true;
                showToast(t('dash.copilotTokenExpired'), 'warning');
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
              const resp = await fetch('/auth/github', { credentials: 'same-origin' });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
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
                  headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                  body: JSON.stringify({ device_code: this.deviceFlow.deviceCode }),
                });
                if (resp.status === 401) {
                  this.logout(t('dash.sessionExpired'));
                  return;
                }
                const d = await resp.json();
                if (d.status === 'complete') {
                  this.cancelDeviceFlow();
                  await this.loadMe();
                  this.githubConnected = this.githubAccounts.length > 0;
                  await this.loadUsage();
                  await this.loadModels();
                } else if (d.status === 'slow_down') {
                  clearInterval(this.deviceFlow.pollTimer);
                  this.pollDeviceFlow((d.interval || interval) + 1);
                } else if (d.status === 'error') {
                  this.cancelDeviceFlow();
                  alert(t('dash.authFailed', { error: d.error }));
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
            if (!confirm(t('dash.confirmDisconnectGithub', { login }))) return;
            try {
              const resp = await fetch('/auth/github/' + userId, { method: 'DELETE', credentials: 'same-origin' });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
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
                alert(t('dash.failedDisconnectGithub'));
              }
            } catch (e) {
              console.error('disconnectGithub:', e);
            }
          },

          async switchGithubAccount(userId) {
            try {
              const resp = await fetch('/auth/github/switch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify({ user_id: userId }),
              });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
                return;
              }
              if (resp.ok) {
                await this.loadMe();
                await this.loadUsage();
              } else {
                alert(t('dash.failedSwitchAccount'));
              }
            } catch (e) {
              console.error('switchGithubAccount:', e);
            }
          },

          openChangePasswordModal() {
            this.cpOldPassword = '';
            this.cpNewPassword = '';
            this.cpConfirmPassword = '';
            this.cpError = '';
            this.changePasswordOpen = true;
          },

          closeChangePasswordModal() {
            this.changePasswordOpen = false;
          },

          async submitChangePassword() {
            this.cpError = '';
            if (!this.cpOldPassword || !this.cpNewPassword || !this.cpConfirmPassword) {
              this.cpError = this.t('dash.changePasswordErrEmpty');
              return;
            }
            if (this.cpNewPassword.length < 6) {
              this.cpError = this.t('dash.passwordMinLength');
              return;
            }
            if (this.cpNewPassword !== this.cpConfirmPassword) {
              this.cpError = this.t('dash.passwordMismatch');
              return;
            }
            this.cpSubmitting = true;
            try {
              const resp = await fetch('/auth/email/change-password', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  old_password: this.cpOldPassword,
                  new_password: this.cpNewPassword,
                }),
              });
              if (resp.ok) {
                this.changePasswordOpen = false;
                this.toast && this.toast(this.t('dash.passwordChangedToast'));
                return;
              }
              let serverError = '';
              try { const data = await resp.json(); serverError = (data && data.error) || ''; } catch (_e) {}
              const lower = serverError.toLowerCase();
              if (resp.status === 401 && lower.includes('incorrect')) {
                this.cpError = this.t('dash.passwordIncorrect');
              } else if (resp.status === 400 && lower.includes('oauth')) {
                this.cpError = this.t('dash.changePasswordErrOAuth');
              } else if (resp.status === 400 && lower.includes('different')) {
                this.cpError = this.t('dash.passwordSameAsOld');
              } else if (resp.status === 400 && lower.includes('6 characters')) {
                this.cpError = this.t('dash.passwordMinLength');
              } else {
                this.cpError = this.t('dash.changePasswordErrGeneric');
              }
            } catch (_e) {
              this.cpError = this.t('dash.changePasswordErrGeneric');
            } finally {
              this.cpSubmitting = false;
            }
          },

          async loadKeys() {
            this.keysLoading = true;
            try {
              const resp = await fetch('/api/keys', { credentials: 'same-origin' });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
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

          async shareKey() {
            this.shareError = '';
            const email = (this.shareEmail || '').trim();
            if (!email || !email.includes('@')) {
              this.shareError = this.t('dash.shareErrInvalidEmail');
              return;
            }
            if (!this.selectedKeyId) return;
            this.sharing = true;
            try {
              const resp = await fetch('/api/keys/' + encodeURIComponent(this.selectedKeyId) + '/assign', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
              });
              if (resp.ok) {
                this.shareEmail = '';
                this.toast && this.toast(this.t('dash.shareToast') + ': ' + email);
                await this.loadKeys();
                return;
              }
              if (resp.status === 404) this.shareError = this.t('dash.shareErrNoUser');
              else if (resp.status === 400) this.shareError = this.t('dash.shareErrSelf');
              else if (resp.status === 409) this.shareError = this.t('dash.shareErrDuplicate');
              else if (resp.status === 403) this.shareError = this.t('dash.shareErrForbidden');
              else this.shareError = this.t('dash.shareErrGeneric');
            } catch (_e) {
              this.shareError = this.t('dash.shareErrGeneric');
            } finally {
              this.sharing = false;
            }
          },

          async unshareKey(userId) {
            if (!this.selectedKeyId || !userId) return;
            try {
              const resp = await fetch('/api/keys/' + encodeURIComponent(this.selectedKeyId) + '/assign/' + encodeURIComponent(userId), {
                method: 'DELETE',
                credentials: 'same-origin',
              });
              if (resp.ok) {
                this.toast && this.toast(this.t('dash.unshareToast'));
                await this.loadKeys();
              } else {
                this.toast && this.toast(this.t('dash.unshareErrGeneric'));
              }
            } catch (_e) {
              this.toast && this.toast(this.t('dash.unshareErrGeneric'));
            }
          },

          async createNewKey() {
            const name = this.newKeyName.trim();
            if (!name) return;
            this.keyCreating = true;
            try {
              const resp = await fetch('/api/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify({ name }),
              });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
                return;
              }
              if (resp.ok) {
                const created = await resp.json();
                this.selectedKeyId = created.id;
                this.newKeyName = '';
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || t('dash.failedCreateKey'));
              }
            } catch (e) {
              console.error('createKey:', e);
            } finally {
              this.keyCreating = false;
            }
          },

          async deleteKeyById(id, name) {
            if (!confirm(t('dash.confirmDeleteKeyNamed', { name }))) return;
            this.keyDeleting = id;
            try {
              const resp = await fetch('/api/keys/' + id, { method: 'DELETE', credentials: 'same-origin' });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
                return;
              }
              if (resp.ok) {
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || t('dash.failedDeleteKey'));
              }
            } catch (e) {
              console.error('deleteKey:', e);
            } finally {
              this.keyDeleting = null;
            }
          },

          async rotateKeyById(id, name) {
            if (!confirm(t('dash.confirmRotateKey', { name }))) return;
            this.keyRotating = id;
            try {
              const resp = await fetch('/api/keys/' + id + '/rotate', { method: 'POST', credentials: 'same-origin' });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
                return;
              }
              if (resp.ok) {
                this.selectedKeyId = id;
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || t('dash.failedRotateKey'));
              }
            } catch (e) {
              console.error('rotateKey:', e);
            } finally {
              this.keyRotating = null;
            }
          },

          async renameKeyById(id, currentName) {
            const newName = prompt(t('dash.renameKey'), currentName);
            if (!newName || newName === currentName) return;
            try {
              const resp = await fetch('/api/keys/' + id, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify({ name: newName }),
              });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
                return;
              }
              if (resp.ok) {
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || t('dash.failedRenameKey'));
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
              const { start, end } = computeTimeRange(this.tokenRange, this.tokenWeekOffset);
              const resp = await this.observabilityFetch('/api/token-usage?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end), { credentials: 'same-origin' });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
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
            if (this.tab !== 'usage') return;
            this.renderTokenChart();
          },

          renderTokenChart() {
            let canvas = document.getElementById('tokenChart');
            if (!canvas || canvas.clientWidth === 0 || !canvas.getContext) return;

            if (this.tokenChart) {
              safeChartDestroy(this.tokenChart, 'tokenChart');
              this.tokenChart = null;
              canvas = document.getElementById('tokenChart');
              if (!canvas) return;
            }

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

            // Build distributions for each unfiltered dimension
            this.tokenByModel = !this.tokenFilterModel
              ? buildDistribution(data, (r) => r.model || 'unknown', (r, k) => k)
              : [];
            this.tokenByKey = !this.tokenFilterKey
              ? buildDistribution(data, (r) => r.keyId, (r) => keyNameMap.get(r.keyId) || r.keyId.slice(0, 8))
              : [];
            this.tokenByClient = !this.tokenFilterClient
              ? buildDistribution(data, (r) => r.client || 'unknown', (r, k) => k)
              : [];
            if (this.isAdmin && !this.tokenFilterUser) {
              this.tokenByUser = buildDistribution(data,
                (r) => r.ownerId || '_admin',
                (r, k) => r.ownerName || (k === '_admin' ? 'Admin' : k.slice(0, 8))
              );
            } else {
              this.tokenByUser = [];
            }

            // Build time-series chart (local time, matches the time-zone label below the chart)
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
            const cacheAgg = new Map();
            for (const [key] of bucketMap) { agg.set(key, new Map()); cacheAgg.set(key, 0); }
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
              const cache = (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);
              const value = this.tokenMetric === 'requests'
                ? r.requests
                : (r.inputTokens + r.outputTokens + cache);
              m.set(seriesKey, (m.get(seriesKey) || 0) + value);
              if (this.tokenMetric === 'tokens') cacheAgg.set(bucket, cacheAgg.get(bucket) + cache);
            }

            const seriesList = [...seriesMap.keys()];
            const labels = [...bucketMap.values()];
            const bucketKeys = [...bucketMap.keys()];

            const unitLabel = this.tokenMetric === 'requests' ? ' req' : ' tokens';
            const base = chartBaseOptions((ctx) => ' ' + ctx.dataset.label + '  ' + ctx.parsed.y.toLocaleString() + unitLabel);

            const datasets = seriesList.map((sk, i) => {
              const c = palette[i % palette.length];
              return {
                label: seriesMap.get(sk),
                data: bucketKeys.map((k) => agg.get(k)?.get(sk) || 0),
                borderColor: c,
                backgroundColor: c + base.fillAlpha,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBorderWidth: 2,
                pointHoverBackgroundColor: base.ptBg,
                pointHoverBorderColor: c,
                tension: 0.4,
                fill: true,
                borderCapStyle: 'round',
                borderJoinStyle: 'round',
              };
            });

            // Add a separate Cache line on top when showing tokens, so cache share is visible
            if (this.tokenMetric === 'tokens') {
              const cacheData = bucketKeys.map((k) => cacheAgg.get(k) || 0);
              if (cacheData.some((v) => v > 0)) {
                const cacheColor = '#a78bfa'; // violet, distinct from palette
                datasets.push({
                  label: 'Cache',
                  data: cacheData,
                  borderColor: cacheColor,
                  backgroundColor: 'transparent',
                  borderWidth: 1.5,
                  borderDash: [4, 4],
                  pointRadius: 0,
                  pointHoverRadius: 4,
                  pointHoverBorderWidth: 2,
                  pointHoverBackgroundColor: base.ptBg,
                  pointHoverBorderColor: cacheColor,
                  tension: 0.4,
                  fill: false,
                  borderCapStyle: 'round',
                  borderJoinStyle: 'round',
                });
              }
            }

            if (this.tab !== 'usage') return;

            const opts = base.options;
            opts.scales.y.ticks.callback = (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v;
            opts.scales.y.beginAtZero = true;

            try {
            this.tokenChart = new Chart(canvas, {
              type: 'line',
              data: { labels, datasets },
              options: opts,
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
            return formatWeekLabel(this.tokenWeekOffset);
          },

          switchTokenFilter() {
            this.$nextTick().then(() => this.renderTokenChart());
          },

          switchTokenMetric(metric) {
            this.tokenMetric = metric;
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
              const { start, end } = computeTimeRange(this.latencyRange, this.latencyWeekOffset);
              const resp = await this.observabilityFetch('/api/latency?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end), { credentials: 'same-origin' });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
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
            if (this.tab !== 'latency') return;
            this.renderLatencyChart();
          },

          renderLatencyChart() {
            let canvas = document.getElementById('latencyChart');
            if (!canvas || canvas.clientWidth === 0 || !canvas.getContext) return;

            if (this.latencyChart) {
              safeChartDestroy(this.latencyChart, 'latencyChart');
              this.latencyChart = null;
              canvas = document.getElementById('latencyChart');
              if (!canvas) return;
            }

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

            // Build time buckets (local time, matches the time-zone label below the chart)
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

            const base = chartBaseOptions((ctx) => ' ' + ctx.dataset.label + '  ' + ctx.parsed.y.toLocaleString() + ' ms');
            const _streamC = isDarkTheme() ? '#7B90FF' : '#4E6CF5';
            const _syncC = isDarkTheme() ? '#50D48A' : '#2CA87A';

            const datasets = [
              {
                label: 'Stream',
                data: bucketKeys.map((k) => avg(aggStream.get(k), reqsStream.get(k))),
                borderColor: _streamC,
                backgroundColor: _streamC + base.fillAlpha,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBorderWidth: 2,
                pointHoverBackgroundColor: base.ptBg,
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
                backgroundColor: _syncC + base.fillAlpha,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBorderWidth: 2,
                pointHoverBackgroundColor: base.ptBg,
                pointHoverBorderColor: _syncC,
                tension: 0.4,
                fill: true,
                borderCapStyle: 'round',
                borderJoinStyle: 'round',
              },
            ];

            if (this.tab !== 'latency') return;

            const opts = base.options;
            opts.scales.y.ticks.callback = (v) => v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms';

            this.latencyChart = new Chart(canvas, {
              type: 'line',
              data: { labels, datasets },
              options: opts,
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
            return formatWeekLabel(this.latencyWeekOffset);
          },

          switchLatencyModel(model) {
            this.latencyModel = model;
            this.$nextTick().then(() => this.renderLatencyChart());
          },

          async exportData() {
            this.exportLoading = true;
            try {
              const resp = await fetch('/api/export', { credentials: 'same-origin' });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
                return;
              }
              if (!resp.ok) {
                alert(t('dash.exportFailedWithError', { error: (await resp.json()).error }));
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
              alert(t('dash.exportFailed'));
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
                  alert(t('dash.invalidExportFile'));
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
                alert(t('dash.invalidJsonFile'));
                this.importFile = null;
              }
            };
            reader.readAsText(file);
          },

          async doImport() {
            if (!this.importData) return;
            if (this.importMode === 'replace') {
              if (!confirm(t('dash.confirmReplaceImport'))) return;
            }
            this.importLoading = true;
            try {
              const resp = await fetch('/api/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify({ mode: this.importMode, data: this.importData }),
              });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
                return;
              }
              const result = await resp.json();
              if (resp.ok) {
                alert(t('dash.importComplete', { keys: result.imported.apiKeys, accounts: result.imported.githubAccounts, usage: result.imported.usage }));
                this.importFile = null;
                this.importData = null;
                this.importPreview = { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0 };
              } else {
                alert(t('dash.importFailedWithError', { error: result.error || 'Unknown error' }));
              }
            } catch (e) {
              console.error('doImport:', e);
              alert(t('dash.importFailed'));
            } finally {
              this.importLoading = false;
            }
          },

          // === Admin: Invite Codes ===
          async loadInviteCodes() {
            this.inviteCodesLoading = true;
            try {
              const resp = await fetch('/auth/admin/invite-codes', { credentials: 'same-origin' });
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
                headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify({ name }),
              });
              if (resp.ok) {
                this.newInviteName = '';
                await this.loadInviteCodes();
              } else {
                alert((await resp.json()).error || t('dash.failedGeneric'));
              }
            } catch (e) {
              console.error('createInviteCode:', e);
            } finally {
              this.inviteCreating = false;
            }
          },

          async deleteInviteCode(id) {
            if (!confirm(t('dash.confirmDeleteInvite'))) return;
            try {
              await fetch('/auth/admin/invite-codes/' + id, { method: 'DELETE', credentials: 'same-origin' });
              await this.loadInviteCodes();
            } catch (e) {
              console.error('deleteInviteCode:', e);
            }
          },

          // === Admin: User Management ===
          async loadAdminUsers() {
            this.adminUsersLoading = true;
            try {
              const resp = await fetch('/auth/admin/users', { credentials: 'same-origin' });
              if (resp.ok) {
                this.adminUsers = await resp.json();
                // Reset previous quota cache when re-loading user list
                this.githubQuotas = {};
                const ghIds = [];
                for (const u of this.adminUsers) {
                  for (const gh of (u.githubAccounts || [])) {
                    if (gh && gh.id != null) ghIds.push(gh.id);
                  }
                }
                ghIds.forEach(id => { this.loadGithubQuota(id); });
              }
            } catch (e) {
              console.error('loadAdminUsers:', e);
            } finally {
              this.adminUsersLoading = false;
            }
          },

          async loadGithubQuota(id) {
            if (id == null) return;
            this.githubQuotas[id] = { loading: true, error: '', data: null };
            this.githubQuotaInflight += 1;
            try {
              const resp = await fetch('/api/admin/copilot-quota/' + encodeURIComponent(id), {
                credentials: 'same-origin',
              });
              if (resp.ok) {
                const data = await resp.json();
                this.githubQuotas[id] = { loading: false, error: '', data };
              } else {
                let errText = '';
                try { const j = await resp.json(); errText = j?.error || ''; } catch (_e) {}
                this.githubQuotas[id] = { loading: false, error: errText || ('HTTP ' + resp.status), data: null };
              }
            } catch (_e) {
              this.githubQuotas[id] = { loading: false, error: this.t('dash.quotaLoadFailed'), data: null };
            } finally {
              this.githubQuotaInflight -= 1;
            }
          },

          formatQuotaChip(q) {
            if (!q) return '…';
            if (q.loading) return '…';
            if (q.error) return '!';
            const snaps = q.data && q.data.quota_snapshots;
            if (!snaps) return '—';
            const snap = snaps.premium_interactions
              || snaps.chat
              || snaps.completions
              || (Object.values(snaps).find(s => s && (s.unlimited || typeof s.entitlement === 'number')));
            if (!snap) return '—';
            if (snap.unlimited) return '∞';
            const used = (snap.entitlement || 0) - (snap.remaining || 0);
            return used + '/' + snap.entitlement;
          },

          // === Key Assignments ===
          assignModalUserId: null,
          assignModalUserName: '',
          assignModalKeys: [],       // [{id, name, assigned}]
          assignModalLoading: false,

          async openAssignModal(userId, userName) {
            this.assignModalUserId = userId;
            this.assignModalUserName = userName;
            this.assignModalLoading = true;
            this.assignModalKeys = [];
            try {
              // Load admin's own keys and the user's current assignments
              const [keysResp, ...assignResps] = await Promise.all([
                fetch('/api/keys', { credentials: 'same-origin' }),
              ]);
              if (!keysResp.ok) return;
              const allKeys = await keysResp.json();
              // Only show keys owned by the current admin, exclude keys owned by the target user
              const ownKeys = allKeys.filter(k => k.is_owner !== false && k.owner_id !== userId);

              // Load assignments for each key to check which are assigned to this user
              const assignments = await Promise.all(ownKeys.map(async (k) => {
                const resp = await fetch('/api/keys/' + k.id + '/assignments', { credentials: 'same-origin' });
                if (!resp.ok) return [];
                return resp.json();
              }));

              this.assignModalKeys = ownKeys.map((k, i) => ({
                id: k.id,
                name: k.name,
                assigned: assignments[i].some(a => a.user_id === userId),
              }));
            } catch (e) {
              console.error('openAssignModal:', e);
            } finally {
              this.assignModalLoading = false;
            }
          },

          async toggleAssignment(keyId, assigned) {
            try {
              if (assigned) {
                // Unassign
                await fetch('/api/keys/' + keyId + '/assign/' + this.assignModalUserId, {
                  method: 'DELETE', credentials: 'same-origin',
                });
              } else {
                // Assign
                await fetch('/api/keys/' + keyId + '/assign', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'same-origin',
                  body: JSON.stringify({ user_id: this.assignModalUserId }),
                });
              }
              // Update local state
              const k = this.assignModalKeys.find(k => k.id === keyId);
              if (k) k.assigned = !assigned;
            } catch (e) {
              console.error('toggleAssignment:', e);
              showToast(t('dash.failedUpdateAssignment'), 'error');
            }
          },

          closeAssignModal() {
            this.assignModalUserId = null;
            this.assignModalUserName = '';
            this.assignModalKeys = [];
            // Refresh user list to update assigned count
            this.loadAdminUsers();
          },

          // === Quota ===
          async loadQuotaUsage(keyId) {
            if (!keyId) {
              this.selectedKeyQuota = { reqLimit: null, reqUsed: 0, reqPercent: 0, tokenLimit: null, tokenUsed: 0, tokenPercent: 0 };
              return;
            }
            const key = this.keys.find(k => k.id === keyId);
            const reqLimit = key?.quota_requests_per_day ?? null;
            const tokenLimit = key?.quota_tokens_per_day ?? null;

            // Fetch today's usage for this key
            const now = new Date();
            const todayStart = now.toISOString().slice(0, 10) + 'T00';
            const tomorrowStart = new Date(now.getTime() + 86400000).toISOString().slice(0, 10) + 'T00';
            try {
              const resp = await fetch('/api/token-usage?start=' + encodeURIComponent(todayStart) + '&end=' + encodeURIComponent(tomorrowStart), { credentials: 'same-origin' });
              if (resp.ok) {
                const data = await resp.json();
                // Filter by keyId
                const keyData = data.filter(r => r.keyId === keyId);
                let reqUsed = 0;
                let weightedTokens = 0;
                for (const r of keyData) {
                  reqUsed += r.requests;
                  weightedTokens += (r.cacheReadTokens || 0) * 0.1 + (r.inputTokens || 0) * 1.0 + (r.outputTokens || 0) * 5.0;
                }
                this.selectedKeyQuota = {
                  reqLimit,
                  reqUsed,
                  reqPercent: reqLimit ? Math.round(reqUsed / reqLimit * 100) : 0,
                  tokenLimit,
                  tokenUsed: weightedTokens,
                  tokenPercent: tokenLimit ? Math.round(weightedTokens / tokenLimit * 100) : 0,
                };
              }
            } catch (e) {
              console.error('loadQuotaUsage:', e);
            }
          },

          startEditQuota() {
            const key = this.keys.find(k => k.id === this.selectedKeyId);
            this.quotaEditReq = key?.quota_requests_per_day ?? null;
            this.quotaEditToken = key?.quota_tokens_per_day ?? null;
            this.quotaEditing = true;
          },

          async saveQuota() {
            if (!this.selectedKeyId) return;
            this.quotaSaving = true;
            try {
              const reqVal = typeof this.quotaEditReq === 'number' && this.quotaEditReq > 0 ? this.quotaEditReq : null;
              const tokenVal = typeof this.quotaEditToken === 'number' && this.quotaEditToken > 0 ? this.quotaEditToken : null;
              const body = {
                quota_requests_per_day: reqVal,
                quota_tokens_per_day: tokenVal,
              };
              const resp = await fetch('/api/keys/' + this.selectedKeyId, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify(body),
              });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
                return;
              }
              if (resp.ok) {
                await this.loadKeys();
                this.quotaEditing = false;
                await this.loadQuotaUsage(this.selectedKeyId);
              } else {
                alert((await resp.json()).error || t('dash.failedUpdateQuota'));
              }
            } catch (e) {
              console.error('saveQuota:', e);
            } finally {
              this.quotaSaving = false;
            }
          },

          // === Web Search ===
          loadWebSearchConfig(keyId) {
            const key = this.keys.find(k => k.id === keyId);
            this.wsConfig = {
              enabled: key?.web_search_enabled ?? false,
              langsearchKey: key?.web_search_langsearch_key ?? null,
              tavilyKey: key?.web_search_tavily_key ?? null,
              msGroundingKey: key?.web_search_ms_grounding_key ?? null,
              langsearchRef: key?.web_search_langsearch_ref ?? null,
              tavilyRef: key?.web_search_tavily_ref ?? null,
              msGroundingRef: key?.web_search_ms_grounding_ref ?? null,
            };
            this.wsUsage = { searches: 0, successes: 0, failures: 0, engines: [], range: this.wsUsageRange };
            // Load usage stats
            fetch('/api/keys/' + keyId + '/web-search-usage?range=' + this.wsUsageRange, { credentials: 'same-origin' })
              .then(r => r.ok ? r.json() : null)
              .then(data => {
                if (data) this.wsUsage = { searches: data.searches, successes: data.successes, failures: data.failures, engines: data.engines || [], range: data.range || this.wsUsageRange };
              })
              .catch(() => {});
          },

          setWsUsageRange(range) {
            this.wsUsageRange = range;
            if (this.selectedKeyId) this.loadWebSearchConfig(this.selectedKeyId);
          },

          startEditWebSearch() {
            const key = this.keys.find(k => k.id === this.selectedKeyId);
            this.wsEditEnabled = key?.web_search_enabled ?? false;
            const ENGINE_IDS = ['msGrounding', 'langsearch', 'tavily', 'bing', 'copilot'];
            const stored = Array.isArray(key?.web_search_priority) ? key.web_search_priority.filter(e => ENGINE_IDS.includes(e)) : [];
            const missing = ENGINE_IDS.filter(e => !stored.includes(e));
            this.wsEditPriority = stored.length ? [...stored, ...missing] : [...ENGINE_IDS];
            this.wsEditLangsearch = '';
            this.wsEditTavily = '';
            this.wsEditMsGrounding = '';
            this.wsEditLangsearchReplacing = false;
            this.wsEditTavilyReplacing = false;
            this.wsEditMsGroundingReplacing = false;
            this.wsEditLangsearchRef = key?.web_search_langsearch_ref?.id ?? '';
            this.wsEditTavilyRef = key?.web_search_tavily_ref?.id ?? '';
            this.wsEditMsGroundingRef = key?.web_search_ms_grounding_ref?.id ?? '';
            this.wsCopySourceId = '';
            this.wsEditing = true;
          },

          async saveWebSearch() {
            if (!this.selectedKeyId) return;
            this.wsSaving = true;
            try {
              const body = {
                web_search_enabled: this.wsEditEnabled,
              };
              if (this.isAdmin) {
                const DEFAULT_ORDER = ['msGrounding', 'langsearch', 'tavily', 'bing', 'copilot'];
                const isDefault = this.wsEditPriority.length === 5
                  && this.wsEditPriority.every((e, i) => e === DEFAULT_ORDER[i]);
                body.web_search_priority = isDefault ? null : this.wsEditPriority;
              }
              if (this.wsEditLangsearchRef) {
                body.web_search_langsearch_ref = this.wsEditLangsearchRef;
              } else if (this.wsEditLangsearch.trim()) {
                body.web_search_langsearch_key = this.wsEditLangsearch.trim();
              } else if (this.wsEditLangsearchReplacing) {
                body.web_search_langsearch_key = null;
              }
              if (this.wsEditTavilyRef) {
                body.web_search_tavily_ref = this.wsEditTavilyRef;
              } else if (this.wsEditTavily.trim()) {
                body.web_search_tavily_key = this.wsEditTavily.trim();
              } else if (this.wsEditTavilyReplacing) {
                body.web_search_tavily_key = null;
              }
              if (this.wsEditMsGroundingRef) {
                body.web_search_ms_grounding_ref = this.wsEditMsGroundingRef;
              } else if (this.wsEditMsGrounding.trim()) {
                body.web_search_ms_grounding_key = this.wsEditMsGrounding.trim();
              } else if (this.wsEditMsGroundingReplacing) {
                body.web_search_ms_grounding_key = null;
              }
              const resp = await fetch('/api/keys/' + this.selectedKeyId, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify(body),
              });
              if (resp.status === 401) { this.logout(t('dash.sessionExpired')); return; }
              if (resp.ok) {
                await this.loadKeys();
                this.wsEditing = false;
                this.loadWebSearchConfig(this.selectedKeyId);
              } else {
                alert((await resp.json()).error || t('dash.failedUpdateWebSearch'));
              }
            } catch (e) {
              console.error('saveWebSearch:', e);
            } finally {
              this.wsSaving = false;
            }
          },

          async copyWebSearchFrom() {
            if (!this.selectedKeyId || !this.wsCopySourceId) return;
            try {
              const resp = await fetch('/api/keys/' + this.selectedKeyId + '/copy-web-search-from/' + this.wsCopySourceId, {
                method: 'POST',
                credentials: 'same-origin',
              });
              if (resp.status === 401) { this.logout(t('dash.sessionExpired')); return; }
              if (resp.ok) {
                await this.loadKeys();
                this.wsEditing = false;
                this.loadWebSearchConfig(this.selectedKeyId);
              } else {
                alert((await resp.json()).error || t('dash.failedCopyWebSearch'));
              }
            } catch (e) {
              console.error('copyWebSearchFrom:', e);
            }
          },

          moveWsPriority(idx, delta) {
            const j = idx + delta;
            if (j < 0 || j >= this.wsEditPriority.length) return;
            const arr = [...this.wsEditPriority];
            [arr[idx], arr[j]] = [arr[j], arr[idx]];
            this.wsEditPriority = arr;
          },
          resetWsPriority() {
            this.wsEditPriority = ['msGrounding', 'langsearch', 'tavily', 'bing', 'copilot'];
          },

          borrowName(id) {
            if (!id) return '';
            const k = this.keys.find(k => k.id === id);
            return k && k.name ? k.name : id;
          },

          get borrowCandidatesLangsearch() {
            return this.keys.filter(k => k.web_search_langsearch_key && k.id !== this.selectedKeyId);
          },
          get borrowCandidatesTavily() {
            return this.keys.filter(k => k.web_search_tavily_key && k.id !== this.selectedKeyId);
          },
          get borrowCandidatesMsGrounding() {
            return this.keys.filter(k => k.web_search_ms_grounding_key && k.id !== this.selectedKeyId);
          },

          async unlinkBorrow(engine) {
            if (!this.selectedKeyId) return;
            const fieldMap = { langsearch: 'web_search_langsearch_ref', tavily: 'web_search_tavily_ref', msGrounding: 'web_search_ms_grounding_ref' };
            const field = fieldMap[engine];
            if (!field) return;
            try {
              const resp = await fetch('/api/keys/' + this.selectedKeyId, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                body: JSON.stringify({ [field]: null }),
              });
              if (resp.status === 401) { this.logout(t('dash.sessionExpired')); return; }
              if (resp.ok) {
                await this.loadKeys();
                this.loadWebSearchConfig(this.selectedKeyId);
              } else {
                alert((await resp.json()).error || t('dash.failedUpdateWebSearch'));
              }
            } catch (e) {
              console.error('unlinkBorrow:', e);
            }
          },

          openBorrowPicker(engine) {
            this.borrowPickerEngine = engine;
          },
          currentBorrowCandidates() {
            if (this.borrowPickerEngine === 'langsearch') return this.borrowCandidatesLangsearch;
            if (this.borrowPickerEngine === 'tavily') return this.borrowCandidatesTavily;
            if (this.borrowPickerEngine === 'msGrounding') return this.borrowCandidatesMsGrounding;
            return [];
          },
          confirmBorrow(id) {
            if (this.borrowPickerEngine === 'langsearch') this.wsEditLangsearchRef = id;
            else if (this.borrowPickerEngine === 'tavily') this.wsEditTavilyRef = id;
            else if (this.borrowPickerEngine === 'msGrounding') this.wsEditMsGroundingRef = id;
            this.borrowPickerEngine = '';
          },

          // === Relays ===
          async loadRelays() {
            this.relaysLoading = true;
            try {
              const resp = await this.observabilityFetch('/api/relays', { credentials: 'same-origin' });
              if (resp.status === 401) {
                this.logout(t('dash.sessionExpired'));
                return;
              }
              if (resp.ok) this.relays = await resp.json();
            } catch (e) {
              console.error('loadRelays:', e);
            } finally {
              this.relaysLoading = false;
            }
          },

          async toggleUser(id, disabled) {
            const action = disabled ? 'enable' : 'disable';
            try {
              await fetch('/auth/admin/users/' + id + '/' + action, { method: 'POST', credentials: 'same-origin' });
              await this.loadAdminUsers();
            } catch (e) {
              console.error('toggleUser:', e);
            }
          },

          async deleteUser(id, name) {
            if (!confirm(t('dash.confirmDeleteUser', { name }))) return;
            try {
              await fetch('/auth/admin/users/' + id, { method: 'DELETE', credentials: 'same-origin' });
              await this.loadAdminUsers();
            } catch (e) {
              console.error('deleteUser:', e);
            }
          },

          logout(reason) {
            if (reason) {
              showToast(reason, 'warning');
            }
            // Clear session cookie
            document.cookie = 'session_token=; Path=/; Max-Age=0';
            document.cookie = 'user_avatar=; Path=/; Max-Age=0';
            document.cookie = 'user_name=; Path=/; Max-Age=0';
            localStorage.removeItem('isAdmin');
            localStorage.removeItem('isUser');
            localStorage.removeItem('userId');
            localStorage.removeItem('userName');
            localStorage.removeItem('userEmail');
            localStorage.removeItem('userAvatar');
            // Also clean up legacy keys
            localStorage.removeItem('authKey');
            localStorage.removeItem('login_key_id');
            localStorage.removeItem('login_key_name');
            localStorage.removeItem('login_key_hint');
            fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
            setTimeout(() => { window.location.href = '/'; }, reason ? 1500 : 0);
          },

        };
      }
    </script>
  `
}
