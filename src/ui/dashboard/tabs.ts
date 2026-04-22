// Dashboard tabs HTML templates

function codeBlock(lang: string, ref: string, snippetFn: string, copyId: string): string {
  return `
    <div class="relative group">
      <pre class="rounded-xl p-4 pr-10 overflow-x-auto code-block"><code class="language-${lang}" x-ref="${ref}" x-effect="$el.textContent = ${snippetFn}(); Prism.highlightElement($el)"></code></pre>
      <button
        @click="copySnippet(${snippetFn}(), '${copyId}')"
        class="absolute top-2.5 right-2.5 p-1.5 rounded-md code-block-btn transition-all opacity-0 group-hover:opacity-100"
        :title="copied === '${copyId}' ? 'Copied!' : 'Copy'"
      >
        <svg x-show="copied !== '${copyId}'" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <svg x-show="copied === '${copyId}'" class="w-3.5 h-3.5 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
    </div>
  `
}

export function renderDashboardHeader(): string {
  return `
    <header class="border-b border-white/5 bg-surface-900/80 backdrop-blur-md sticky top-0 z-50" style="border-color: var(--border-color);">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-surface-700 glow-border flex items-center justify-center">
            <svg class="w-4 h-4 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span class="font-semibold text-sm tracking-tight" style="color: var(--text-primary);" x-text="t('dash.title')"></span>
        </div>
        <div class="flex items-center gap-3">
          <button onclick="toggleLang()" class="theme-toggle"><span class="text-xs font-semibold" id="__lang_btn"></span></button><script>document.getElementById('__lang_btn').textContent = window.__lang === 'zh' ? 'EN' : '中';</script>
          <button onclick="toggleTheme(); if(window.dashboardApp && window.dashboardApp.onThemeChange) window.dashboardApp.onThemeChange();" class="theme-toggle" title="Toggle theme">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          </button>
          <!-- User menu -->
          <div class="relative" x-data="{ userMenuOpen: false }" @click.outside="userMenuOpen = false">
            <button @click="userMenuOpen = !userMenuOpen" class="flex items-center gap-2 rounded-full hover:opacity-80 transition-opacity cursor-pointer bg-transparent border-0 p-0">
              <img x-show="getUserAvatar()" :src="getUserAvatar()" class="w-8 h-8 rounded-full" referrerpolicy="no-referrer" @error="$el.style.display='none'; $el.nextElementSibling.style.display='flex'" />
              <div x-show="!getUserAvatar()" class="w-8 h-8 rounded-full bg-accent-violet/20 flex items-center justify-center text-accent-violet text-xs font-medium" x-text="(localStorage.getItem('userEmail') || localStorage.getItem('userName') || '?')[0].toUpperCase()"></div>
            </button>
            <!-- Dropdown -->
            <div x-show="userMenuOpen" x-transition class="absolute right-0 mt-2 w-56 rounded-lg shadow-lg border bg-surface-800 border-white/10 py-1 z-50" style="border-color: var(--border-color); background: var(--surface-800);">
              <div class="px-4 py-2.5 border-b border-white/5" style="border-color: var(--border-color);">
                <div class="text-sm font-medium text-themed" x-text="decodeURIComponent(getCookie('user_name') || localStorage.getItem('userName') || '')"></div>
                <div class="text-xs text-themed-dim mt-0.5" x-text="localStorage.getItem('userEmail') || ''"></div>
                <template x-if="isAdmin">
                  <span class="inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] bg-accent-violet/10 text-accent-violet uppercase font-medium">Admin</span>
                </template>
              </div>
              <template x-if="isAdmin">
                <button @click="switchTab('settings'); userMenuOpen = false" class="w-full text-left px-4 py-2 text-sm text-themed-dim hover:text-themed hover:bg-surface-700 transition-colors cursor-pointer bg-transparent border-0">
                  <svg class="w-4 h-4 inline mr-2 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  <span x-text="t('dash.settings')"></span>
                </button>
              </template>
              <button @click="logout()" class="w-full text-left px-4 py-2 text-sm text-accent-red/80 hover:text-accent-red hover:bg-surface-700 transition-colors cursor-pointer bg-transparent border-0">
                <svg class="w-4 h-4 inline mr-2 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                <span x-text="t('dash.signOut')"></span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="max-w-6xl mx-auto px-4 sm:px-6 pb-3" x-show="tab !== 'settings'">
        <nav class="flex gap-1 bg-surface-800 rounded-lg p-0.5 overflow-x-auto scrollbar-hide">
          <template x-if="isAdmin || isUser">
            <button @click="switchTab('upstream')" class="px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-xs sm:text-sm font-medium transition-all whitespace-nowrap"
              :class="tab === 'upstream' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'"
              x-text="t('dash.upstream')">
            </button>
          </template>
          <template x-if="isAdmin">
            <button @click="switchTab('users')" class="px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-xs sm:text-sm font-medium transition-all whitespace-nowrap"
              :class="tab === 'users' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'"
              x-text="t('dash.users')">
            </button>
          </template>
          <button @click="switchTab('keys')" class="px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-xs sm:text-sm font-medium transition-all whitespace-nowrap"
            :class="tab === 'keys' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'"
            x-text="t('dash.apiKeys')">
          </button>
          <button @click="switchTab('usage')" class="px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-xs sm:text-sm font-medium transition-all whitespace-nowrap"
            :class="tab === 'usage' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'"
            x-text="t('dash.usage')">
          </button>
          <button @click="switchTab('latency')" class="px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-xs sm:text-sm font-medium transition-all whitespace-nowrap"
            :class="tab === 'latency' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'"
            x-text="t('dash.latency')">
          </button>
          <template x-if="isAdmin || isUser">
            <button @click="switchTab('relays')" class="px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-xs sm:text-sm font-medium transition-all whitespace-nowrap"
              :class="tab === 'relays' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'"
              x-text="t('dash.relays')">
            </button>
          </template>
        </nav>
      </div>
    </header>
  `
}

export function renderUsersTab(): string {
  return `
    <div x-show="tab === 'users'" x-cloak>
      <!-- Invite Codes -->
      <div class="glass-card p-6 mb-6">
        <h2 class="text-lg font-semibold text-themed mb-4" x-text="t('dash.inviteCodes')"></h2>
        <div class="flex flex-col sm:flex-row gap-3 mb-4">
          <input type="text" x-model="newInviteName" :placeholder="t('dash.invitePlaceholder')" class="flex-1" @keydown.enter="createInviteCode()" />
          <button @click="createInviteCode()" class="btn-primary text-sm" :disabled="inviteCreating || !newInviteName.trim()">
            <span x-show="!inviteCreating" x-text="t('dash.createInvite')"></span>
            <span x-show="inviteCreating" x-text="t('common.creating')"></span>
          </button>
        </div>

        <div x-show="inviteCodesLoading" class="text-center py-4 text-themed-dim text-sm" x-text="t('common.loading')"></div>
        <div x-show="!inviteCodesLoading && inviteCodes.length === 0" class="text-center py-4 text-themed-dim text-sm" x-text="t('dash.noInvites')"></div>

        <div x-show="!inviteCodesLoading && inviteCodes.length > 0" class="space-y-2">
          <template x-for="inv in inviteCodes" :key="inv.id">
            <div class="flex items-center gap-3 p-3 rounded-lg bg-surface-800/50 border border-white/[0.04] overflow-x-auto scrollbar-hide whitespace-nowrap">
              <div class="flex items-center gap-3">
                <span class="text-sm font-medium text-themed" x-text="inv.name"></span>
                <template x-if="!inv.usedAt">
                  <span class="px-2 py-0.5 rounded text-xs font-mono bg-accent-violet/10 text-accent-violet cursor-pointer" @click="copySnippet(inv.code, 'inv-' + inv.id)" x-text="inv.code"></span>
                </template>
                <template x-if="inv.usedAt">
                  <span class="px-2 py-0.5 rounded text-xs bg-accent-teal/10 text-accent-teal" x-text="t('dash.used')"></span>
                </template>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-xs text-themed-dim" x-text="timeAgo(inv.createdAt)"></span>
                <template x-if="!inv.usedAt">
                  <button @click="copySnippet(inv.code, 'inv-' + inv.id)" class="text-themed-dim hover:text-accent-violet transition-colors" title="Copy code">
                    <svg x-show="copied !== 'inv-' + inv.id" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <svg x-show="copied === 'inv-' + inv.id" class="w-4 h-4 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </button>
                </template>
                <button @click="deleteInviteCode(inv.id)" class="text-themed-dim hover:text-accent-red transition-colors">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Users List -->
      <div class="glass-card p-6">
        <h2 class="text-lg font-semibold text-themed mb-4" x-text="t('dash.usersList')"></h2>
        <div x-show="adminUsersLoading" class="text-center py-4 text-themed-dim text-sm" x-text="t('common.loading')"></div>
        <div x-show="!adminUsersLoading && adminUsers.length === 0" class="text-center py-8 text-themed-dim text-sm" x-text="t('dash.noUsers')"></div>

        <div x-show="!adminUsersLoading && adminUsers.length > 0" class="space-y-2">
          <template x-for="u in adminUsers" :key="u.id">
            <div class="flex items-start sm:items-center justify-between gap-3 p-4 rounded-lg bg-surface-800/50 border border-white/[0.04] flex-wrap">
              <div class="flex items-center gap-4">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-themed" x-text="u.name"></span>
                    <template x-if="u.disabled">
                      <span class="px-1.5 py-0.5 rounded text-[10px] bg-accent-red/10 text-accent-red uppercase" x-text="t('dash.disabled')"></span>
                    </template>
                  </div>
                  <div class="flex items-center gap-3 mt-0.5">
                    <template x-if="u.email">
                      <span class="text-xs text-accent-violet" x-text="u.email"></span>
                    </template>
                    <template x-for="gh in (u.githubAccounts || [])" :key="gh.id">
                      <span class="text-xs text-themed-dim" x-text="'@' + gh.login"></span>
                    </template>
                    <span class="text-xs text-themed-dim" x-text="u.keyCount + ' own'"></span>
                    <span x-show="u.sharedKeyCount > 0" class="text-xs text-accent-violet" x-text="u.sharedKeyCount + ' shared'"></span>
                    <span class="text-xs text-themed-dim" x-text="'Joined ' + timeAgo(u.createdAt)"></span>
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <template x-if="u.id !== userId"><button @click="openAssignModal(u.id, u.name)" class="btn-ghost text-xs" x-text="t('dash.assignKeys')"></button></template>
                <button @click="toggleUser(u.id, u.disabled)" class="btn-ghost text-xs" x-text="u.disabled ? t('dash.enable') : t('dash.disable')"></button>
                <button @click="deleteUser(u.id, u.name)" class="btn-ghost text-xs text-accent-red hover:bg-accent-red/10" x-text="t('dash.delete')"></button>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Assign Keys Modal -->
      <template x-if="assignModalUserId">
        <div class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 animate-in" @click.self="closeAssignModal()">
          <div style="background: var(--surface-900); border: 1px solid var(--glass-border); border-radius: 16px; box-shadow: var(--card-shadow), 0 24px 48px rgba(0,0,0,0.12);" class="p-5 max-w-sm w-full mx-4">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-themed text-sm font-semibold" x-text="t('dash.assignKeysTo') + assignModalUserName"></h3>
              <button @click="closeAssignModal()" class="text-themed-dim hover:text-themed transition-colors">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>

            <div x-show="assignModalLoading" class="text-center py-6 text-themed-dim text-xs" x-text="t('common.loading')"></div>
            <div x-show="!assignModalLoading && assignModalKeys.length === 0" class="text-center py-6 text-themed-dim text-xs" x-text="t('dash.noKeysAvailable')"></div>

            <div x-show="!assignModalLoading && assignModalKeys.length > 0" class="max-h-64 overflow-y-auto" style="scrollbar-width: none;">
              <template x-for="k in assignModalKeys" :key="k.id">
                <div @click="toggleAssignment(k.id, k.assigned)"
                  class="flex items-center gap-3 py-2.5 px-1 cursor-pointer select-none transition-colors duration-100 rounded-md"
                  :class="k.assigned ? 'hover:bg-accent-violet/5' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'">
                  <div class="w-[18px] h-[18px] rounded-full shrink-0 flex items-center justify-center transition-all duration-150"
                    :class="k.assigned ? 'bg-accent-violet' : ''"
                    :style="!k.assigned ? 'border: 2px solid var(--surface-600)' : ''">
                    <svg x-show="k.assigned" class="w-2.5 h-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <span class="text-[13px]" :class="k.assigned ? 'text-themed font-medium' : 'text-themed-secondary'" x-text="k.name"></span>
                </div>
              </template>
            </div>

            <div x-show="!assignModalLoading && assignModalKeys.length > 0" class="mt-4 flex items-center justify-between">
              <span class="text-[11px] text-themed-dim"><span class="text-accent-violet font-mono font-medium" x-text="assignModalKeys.filter(k => k.assigned).length"></span> / <span x-text="assignModalKeys.length"></span> assigned</span>
              <button @click="closeAssignModal()" class="btn-primary !text-xs !py-1.5 !px-5 !rounded-lg" x-text="t('dash.done')"></button>
            </div>
          </div>
        </div>
      </template>
    </div>
  `
}

export function renderUpstreamTab(): string {
  return `
    <template x-if="isAdmin || isUser">
      <div x-show="tab === 'upstream'" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100">
        <template x-if="meLoaded && githubAccounts.length === 0">
          <div class="glass-card p-6 mb-8 glow-border animate-in flex items-center justify-between">
            <div>
              <h3 class="text-themed font-medium mb-1" x-text="t('dash.connectGithub')"></h3>
              <p class="text-sm text-themed-secondary" x-text="t('dash.connectGithubDesc')"></p>
            </div>
            <button @click="startGithubAuth()" class="btn-primary" :disabled="deviceFlow.loading">
              <span x-show="!deviceFlow.loading" x-text="t('dash.connectGithubBtn')"></span>
              <span x-show="deviceFlow.loading" class="flex items-center gap-2">
                <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
                Connecting…
              </span>
            </button>
          </div>
        </template>

        <template x-if="deviceFlow.userCode">
          <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in">
            <div class="glass-card p-8 max-w-md w-full mx-4 glow-primary">
              <h3 class="text-themed text-lg font-semibold mb-2" x-text="t('dash.githubAuth')"></h3>
              <p class="text-themed-secondary text-sm mb-6" x-text="t('dash.githubAuthDesc')"></p>
              <div class="bg-surface-900 rounded-xl p-6 text-center mb-6 glow-border">
                <code class="text-3xl font-mono font-bold text-accent-violet tracking-[0.3em]" x-text="deviceFlow.userCode"></code>
              </div>
              <p class="text-themed-dim text-xs text-center mb-2">
                Visit <a :href="deviceFlow.verificationUri" class="text-accent-violet hover:underline" x-text="deviceFlow.verificationUri" target="_blank"></a>
              </p>
              <a :href="deviceFlow.verificationUri" target="_blank" class="btn-primary w-full block text-center mb-4" @click="navigator.clipboard.writeText(deviceFlow.userCode)" x-text="t('dash.openGithub')"></a>
              <div class="flex items-center justify-center gap-2 text-sm text-themed-dim">
                <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
                Waiting for authorization...
              </div>
              <button @click="cancelDeviceFlow()" class="btn-ghost w-full mt-4" x-text="t('dash.cancel')"></button>
            </div>
          </div>
        </template>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
          <div class="glass-card p-6 hover-lift animate-in delay-1">
            <div class="flex items-center justify-between mb-4">
              <span class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.premiumRequests')"></span>
              <div class="w-2 h-2 rounded-full status-pulse" :class="usageData ? (usagePercent > 90 ? 'bg-accent-red' : usagePercent > 70 ? 'bg-accent-amber' : 'bg-accent-teal') : 'bg-gray-600'"></div>
            </div>
            <template x-if="usageData">
              <div>
                <div class="flex items-baseline gap-2 mb-3">
                  <span class="text-2xl sm:text-3xl font-bold text-themed font-mono" x-text="usageData.quota_snapshots.premium_interactions.entitlement - usageData.quota_snapshots.premium_interactions.remaining"></span>
                  <span class="text-sm text-themed-dim">/ <span x-text="usageData.quota_snapshots.premium_interactions.entitlement"></span></span>
                </div>
                <div class="progress-track">
                  <div class="progress-fill" :class="usagePercent > 90 ? 'bg-accent-red' : usagePercent > 70 ? 'bg-gradient-to-r from-accent-amber to-accent-red' : 'bg-gradient-to-r from-accent-violet to-accent-teal'" :style="'width:' + usagePercent + '%'"></div>
                </div>
                <p class="text-xs text-themed-dim mt-2">
                  <span x-text="usageData.quota_snapshots.premium_interactions.remaining"></span> remaining · Resets <span x-text="formatDate(usageData.quota_reset_date)"></span>
                </p>
              </div>
            </template>
            <template x-if="!usageData && !usageError">
              <div class="space-y-2">
                <div class="h-8 bg-surface-600 rounded animate-pulse"></div>
                <div class="h-2 bg-surface-600 rounded animate-pulse"></div>
              </div>
            </template>
            <template x-if="usageError">
              <p class="text-sm" style="color: #e67e22;" x-text="t('dash.connectGithubToView')"></p>
            </template>
          </div>

          <div class="glass-card p-6 hover-lift animate-in delay-2">
            <div class="flex items-center justify-between mb-4">
              <span class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.chatQuota')"></span>
            </div>
            <template x-if="usageData">
              <div>
                <div class="flex items-baseline gap-2 mb-1">
                  <span class="text-2xl font-bold text-themed font-mono" x-text="usageData.quota_snapshots.chat.unlimited ? '∞' : usageData.quota_snapshots.chat.remaining"></span>
                  <span class="text-xs text-themed-dim" x-show="!usageData.quota_snapshots.chat.unlimited">remaining</span>
                  <span class="text-xs text-accent-teal" x-show="usageData.quota_snapshots.chat.unlimited">unlimited</span>
                </div>
                <p class="text-xs text-themed-dim"><span x-text="t('dash.plan')"></span><span class="text-themed-secondary" x-text="usageData.copilot_plan"></span></p>
              </div>
            </template>
            <template x-if="!usageData && !usageError">
              <div class="space-y-2">
                <div class="h-8 bg-surface-600 rounded animate-pulse"></div>
                <div class="h-2 bg-surface-600 rounded animate-pulse"></div>
              </div>
            </template>
            <template x-if="usageError">
              <p class="text-sm" style="color: #e67e22;" x-text="t('dash.connectGithubToView')"></p>
            </template>
          </div>

          <div class="glass-card p-6 hover-lift animate-in delay-3">
            <div class="flex items-center justify-between mb-4">
              <span class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.completions')"></span>
            </div>
            <template x-if="usageData">
              <div>
                <div class="flex items-baseline gap-2 mb-1">
                  <span class="text-2xl font-bold text-themed font-mono" x-text="usageData.quota_snapshots.completions.unlimited ? '∞' : usageData.quota_snapshots.completions.remaining"></span>
                  <span class="text-xs text-themed-dim" x-show="!usageData.quota_snapshots.completions.unlimited">remaining</span>
                  <span class="text-xs text-accent-teal" x-show="usageData.quota_snapshots.completions.unlimited">unlimited</span>
                </div>
                <p class="text-xs text-themed-dim" x-text="t('dash.codeCompletions')"></p>
              </div>
            </template>
            <template x-if="!usageData && !usageError">
              <div class="space-y-2">
                <div class="h-8 bg-surface-600 rounded animate-pulse"></div>
                <div class="h-2 bg-surface-600 rounded animate-pulse"></div>
              </div>
            </template>
            <template x-if="usageError">
              <p class="text-sm" style="color: #e67e22;" x-text="t('dash.connectGithubToView')"></p>
            </template>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div class="glass-card p-6 animate-in delay-4">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.githubAccounts')"></h3>
              <template x-if="meLoaded && githubAccounts.length > 0">
                <button @click="startGithubAuth()" class="btn-ghost text-xs" :disabled="deviceFlow.loading">
                  <span x-show="!deviceFlow.loading">+ Add</span>
                  <span x-show="deviceFlow.loading" class="flex items-center gap-1.5">
                    <svg class="animate-spin h-3 w-3" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                    </svg>
                    Adding…
                  </span>
                </button>
              </template>
            </div>
            <template x-if="!meLoaded">
              <div class="space-y-3">
                <div class="flex items-center gap-3">
                  <div class="w-9 h-9 rounded-lg bg-surface-600 animate-pulse shrink-0"></div>
                  <div class="space-y-1.5 flex-1">
                    <div class="h-4 w-28 bg-surface-600 rounded animate-pulse"></div>
                    <div class="h-3 w-20 bg-surface-600 rounded animate-pulse"></div>
                  </div>
                </div>
              </div>
            </template>
            <template x-if="meLoaded && githubAccounts.length === 0">
              <p class="text-sm text-themed-dim" x-text="t('dash.noGithubAccounts')"></p>
            </template>
            <template x-if="meLoaded && githubAccounts.length > 0">
              <div class="space-y-1">
                <template x-for="acct in githubAccounts" :key="acct.id">
                  <div @click="!acct.active && acct.token_valid && !(isAdmin && acct.owner_id) && switchGithubAccount(acct.id)" class="flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors"
                    :class="isAdmin && acct.owner_id ? 'opacity-50 border border-white/[0.04]' : !acct.token_valid ? 'bg-accent-red/5 border border-accent-red/15' : acct.active ? 'bg-accent-violet/5 border border-accent-violet/15' : 'hover:bg-white/[0.03] cursor-pointer border border-transparent'">
                    <div class="flex items-center gap-3">
                      <div class="relative">
                        <img :src="acct.avatar_url || 'https://avatars.githubusercontent.com/u/' + acct.id + '?v=4'" @error.once="$el.style.display='none'; $el.nextElementSibling.style.display=''" class="w-9 h-9 rounded-lg ring-1 ring-white/5" :class="(!acct.token_valid || (isAdmin && acct.owner_id)) ? 'opacity-50' : ''" /><div style="display:none" class="w-9 h-9 rounded-lg ring-1 ring-white/5 bg-surface-700 flex items-center justify-center text-themed-dim text-sm" :class="(!acct.token_valid || (isAdmin && acct.owner_id)) ? 'opacity-50' : ''" x-text="(acct.login || '?')[0].toUpperCase()"></div>
                        <div x-show="!acct.token_valid" class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-accent-red ring-2 ring-surface-800"></div>
                        <div x-show="acct.token_valid && acct.active" class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-accent-teal ring-2 ring-surface-800"></div>
                      </div>
                      <div>
                        <p class="text-sm font-medium" :class="(isAdmin && acct.owner_id) ? 'text-themed-dim' : !acct.token_valid ? 'text-themed-secondary' : 'text-themed'" x-text="acct.name || acct.login"></p>
                        <div class="flex items-center gap-2">
                          <p class="text-xs text-themed-dim" x-text="'@' + acct.login"></p>
                          <template x-if="isAdmin && acct.owner_name">
                            <span class="text-[10px] px-1.5 py-0.5 rounded bg-surface-700 text-themed-dim" x-text="acct.owner_name"></span>
                          </template>
                        </div>
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      <span x-show="!acct.token_valid" class="text-[10px] font-medium text-accent-red uppercase tracking-widest" x-text="t('dash.tokenExpired')"></span>
                      <span x-show="acct.token_valid && acct.active" class="text-[10px] font-medium text-accent-teal uppercase tracking-widest" x-text="t('dash.active')"></span>
                      <button x-show="!(isAdmin && acct.owner_id)" @click.stop="disconnectGithub(acct.id, acct.login)" class="text-themed-dim hover:text-accent-red transition-colors p-1" title="Disconnect">
                        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </template>
              </div>
            </template>
          </div>

          <div class="glass-card p-6 animate-in delay-5">
            <h3 class="text-xs font-medium text-themed-dim uppercase tracking-widest mb-4">API Endpoints</h3>
            <div class="space-y-3 font-mono text-xs">
              <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 rounded bg-accent-teal/10 text-accent-teal text-[10px] font-bold">POST</span>
                <span class="text-themed-secondary">/v1/chat/completions</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 rounded bg-accent-teal/10 text-accent-teal text-[10px] font-bold">POST</span>
                <span class="text-themed-secondary">/v1/messages</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 rounded bg-accent-teal/10 text-accent-teal text-[10px] font-bold">POST</span>
                <span class="text-themed-secondary">/v1/responses</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 rounded bg-accent-violet/10 text-accent-violet text-[10px] font-bold">GET</span>
                <span class="text-themed-secondary">/v1/models</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  `
}

export function renderKeysTab(): string {
  return `
    <div x-show="tab === 'keys'">
      <div class="glass-card p-6 mb-6 animate-in">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <span class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.apiKeys')"></span>
          <div x-show="isAdmin || isUser" class="flex items-center gap-2">
            <input type="text" x-model="newKeyName" placeholder="Name" class="!text-xs !py-1.5 !px-3 !w-full sm:!w-32 !rounded-lg" @keydown.enter="createNewKey()" />
            <button @click="createNewKey()" class="btn-primary !text-xs !py-1.5 !px-3 !rounded-lg whitespace-nowrap" :disabled="!newKeyName.trim() || keyCreating">
              <span x-show="!keyCreating">+ Create</span>
              <span x-show="keyCreating" class="flex items-center gap-1.5">
                <svg class="animate-spin h-3 w-3" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
                Creating…
              </span>
            </button>
          </div>
        </div>

        <div class="overflow-x-auto">
          <template x-if="keys.length === 0 && !keysLoading">
            <p class="text-sm text-themed-dim py-4 text-center" x-text="t('dash.noApiKeys')"></p>
          </template>
          <template x-if="keysLoading && keys.length === 0">
            <div class="space-y-3 py-2">
              <div class="h-10 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-10 bg-surface-600 rounded animate-pulse"></div>
            </div>
          </template>
          <template x-if="keys.length > 0">
            <table class="w-full text-sm whitespace-nowrap">
              <thead>
                <tr class="border-b border-white/5">
                  <th class="text-left py-2 pr-4 pl-7 text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.name')"></th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.owner')"></th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.key')"></th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest hidden sm:table-cell" x-text="t('dash.created')"></th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest hidden sm:table-cell" x-text="t('dash.lastUsed')"></th>
                  <th x-show="isAdmin || isUser" class="text-right py-2 pr-2 text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.actions')"></th>
                </tr>
              </thead>
              <tbody>
                <template x-for="k in keys" :key="k.id">
                  <tr @click="selectedKeyId = k.id" class="border-b border-white/[0.03] transition-colors cursor-pointer"
                    :class="selectedKeyId === k.id ? 'bg-accent-violet/5 hover:bg-accent-violet/8' : 'hover:bg-white/[0.02]'">
                    <td class="py-3 pr-4 pl-2">
                      <div class="flex items-center gap-2">
                        <div class="w-1.5 h-1.5 rounded-full shrink-0 transition-colors" :class="selectedKeyId === k.id ? 'bg-accent-violet' : 'bg-transparent'"></div>
                        <span class="text-themed font-medium" x-text="k.name"></span>
                      </div>
                    </td>
                    <td class="py-3 pr-4">
                      <span x-show="k.owner_name" class="text-xs text-themed-secondary" x-text="k.owner_name"></span>
                      <span x-show="!k.owner_name && k.is_owner !== false" class="text-xs text-themed-dim">&mdash;</span>
                      <span x-show="k.is_owner === false" class="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-accent-violet/10 text-accent-violet" x-text="t('dash.shared')"></span>
                      <template x-if="k.is_owner !== false && k.assignees && k.assignees.length > 0">
                        <span class="ml-1 text-[10px] text-themed-dim cursor-default" :title="k.assignees.map(a => a.user_name || 'Unknown').join(', ')">
                          <span class="px-1.5 py-0.5 rounded bg-accent-teal/10 text-accent-teal" x-text="'Shared: ' + k.assignees.length"></span>
                        </span>
                      </template>
                    </td>
                    <td class="py-3 pr-4">
                      <code class="text-xs font-mono text-themed-dim bg-surface-800 rounded px-2 py-1" x-text="truncateKey(k.key)"></code>
                    </td>
                    <td class="py-3 pr-4 hidden sm:table-cell">
                      <span class="text-themed-dim text-xs cursor-default" :title="fullDateTime(k.created_at)" x-text="timeAgo(k.created_at)"></span>
                    </td>
                    <td class="py-3 pr-4 hidden sm:table-cell">
                      <span x-show="k.last_used_at" class="text-themed-dim text-xs cursor-default" :title="fullDateTime(k.last_used_at)" x-text="timeAgo(k.last_used_at)"></span>
                      <span x-show="!k.last_used_at" class="text-themed-dim text-xs" x-text="t('dash.never')"></span>
                    </td>
                    <td class="py-3 pr-2 text-right">
                      <div class="flex items-center justify-end gap-1">
                        <button @click.stop="copySnippet(k.key, 'key-' + k.id)" class="text-themed-dim hover:text-accent-violet transition-colors p-1" title="Copy key">
                          <svg x-show="copied !== 'key-' + k.id" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                          <svg x-show="copied === 'key-' + k.id" class="w-4 h-4 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </button>
                        <template x-if="(isAdmin || isUser) && k.is_owner !== false">
                          <button @click.stop="deleteKeyById(k.id, k.name)" class="text-themed-dim hover:text-accent-red transition-colors p-1" :disabled="keyDeleting === k.id" title="Delete key">
                            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </template>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </template>
        </div>
      </div>

      <!-- Shared Users Panel (shown for owned keys) -->
      <template x-if="selectedKeyId && keys.find(k => k.id === selectedKeyId)?.is_owner !== false">
        <div class="glass-card p-6 mb-6 animate-in delay-1">
          <span class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.sharedWith')"></span>
          <div class="flex flex-wrap gap-2 mt-3">
            <template x-for="a in keys.find(k => k.id === selectedKeyId)?.assignees || []" :key="a.user_id">
              <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-accent-violet/10 text-accent-violet border border-accent-violet/20">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <span x-text="a.user_name || 'Unknown'"></span>
                <button type="button" @click="unshareKey(a.user_id)" class="ml-1 -mr-0.5 hover:text-red-400 transition-colors" :title="t('dash.unshare')">
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </span>
            </template>
          </div>
          <div class="mt-4 flex items-center gap-2">
            <input
              type="email"
              x-model="shareEmail"
              @input="shareError = ''"
              @keydown.enter.prevent="shareKey()"
              :placeholder="t('dash.shareEmailPlaceholder')"
              class="!text-xs !py-1.5 !px-3 flex-1 !rounded-lg"
              :disabled="sharing"
            />
            <button
              type="button"
              @click="shareKey()"
              class="btn-primary !text-xs !py-1.5 !px-3"
              :disabled="sharing || !shareEmail"
              x-text="t('dash.share')"
            ></button>
          </div>
          <p x-show="shareError" x-text="shareError" class="mt-2 text-xs text-red-400"></p>
        </div>
      </template>

      <!-- Quota Panel (shown when a key is selected) -->
      <template x-if="selectedKeyId">
        <div class="glass-card p-6 mb-6 animate-in delay-1">
          <div class="flex items-center justify-between mb-4">
            <span class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.dailyQuota')"></span>
            <div class="flex items-center gap-2">
              <template x-if="!quotaEditing">
                <button @click="startEditQuota()" class="btn-ghost text-xs" x-show="(isAdmin || isUser) && keys.find(k => k.id === selectedKeyId)?.is_owner !== false" x-text="t('dash.edit')"></button>
              </template>
              <template x-if="quotaEditing">
                <div class="flex items-center gap-2">
                  <button @click="saveQuota()" class="btn-primary !text-xs !py-1 !px-3" :disabled="quotaSaving">
                    <span x-show="!quotaSaving" x-text="t('dash.save')"></span>
                    <span x-show="quotaSaving" x-text="t('dash.saving')"></span>
                  </button>
                  <button @click="quotaEditing = false" class="btn-ghost text-xs" x-text="t('dash.cancel')"></button>
                </div>
              </template>
            </div>
          </div>

          <!-- Edit form -->
          <template x-if="quotaEditing">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label class="text-xs text-themed-dim block mb-1" x-text="t('dash.requestsPerDay')"></label>
                <input type="number" x-model.number="quotaEditReq" min="0" placeholder="Unlimited"
                  class="!text-xs !py-1.5 !px-3 w-full !rounded-lg" />
                <p class="text-[10px] text-themed-dim mt-1" x-text="t('dash.leaveEmptyUnlimited')"></p>
              </div>
              <div>
                <label class="text-xs text-themed-dim block mb-1" x-text="t('dash.weightedTokensPerDay')"></label>
                <input type="number" x-model.number="quotaEditToken" min="0" placeholder="Unlimited"
                  class="!text-xs !py-1.5 !px-3 w-full !rounded-lg" />
                <p class="text-[10px] text-themed-dim mt-1" x-text="t('dash.leaveEmptyUnlimited')"></p>
              </div>
            </div>
          </template>

          <!-- Request Quota -->
          <div class="mb-5">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs text-themed-secondary" x-text="t('dash.requestsPerDay')"></span>
              <span class="text-xs font-mono" :class="selectedKeyQuota.reqLimit ? 'text-themed' : 'text-themed-dim'"
                x-text="selectedKeyQuota.reqLimit ? (selectedKeyQuota.reqUsed + ' / ' + selectedKeyQuota.reqLimit) : 'Unlimited'"></span>
            </div>
            <template x-if="selectedKeyQuota.reqLimit">
              <div>
                <div class="progress-track">
                  <div class="progress-fill"
                    :class="selectedKeyQuota.reqPercent > 90 ? 'bg-accent-red' : selectedKeyQuota.reqPercent > 70 ? 'bg-gradient-to-r from-accent-amber to-accent-red' : 'bg-gradient-to-r from-accent-violet to-accent-teal'"
                    :style="'width:' + Math.min(selectedKeyQuota.reqPercent, 100) + '%'"></div>
                </div>
                <p class="text-[10px] text-themed-dim mt-1">
                  <span x-text="Math.max(0, selectedKeyQuota.reqLimit - selectedKeyQuota.reqUsed)"></span> remaining
                  <span x-show="selectedKeyQuota.reqPercent >= 100" class="text-accent-red font-medium ml-1">QUOTA EXCEEDED</span>
                </p>
              </div>
            </template>
            <template x-if="!selectedKeyQuota.reqLimit">
              <div class="progress-track">
                <div class="progress-fill bg-surface-600" style="width: 100%"></div>
              </div>
            </template>
          </div>

          <!-- Token Quota -->
          <div class="mb-4">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs text-themed-secondary" x-text="t('dash.weightedTokensPerDay')"></span>
              <span class="text-xs font-mono" :class="selectedKeyQuota.tokenLimit ? 'text-themed' : 'text-themed-dim'"
                x-text="selectedKeyQuota.tokenLimit ? (Math.round(selectedKeyQuota.tokenUsed).toLocaleString() + ' / ' + selectedKeyQuota.tokenLimit.toLocaleString()) : 'Unlimited'"></span>
            </div>
            <template x-if="selectedKeyQuota.tokenLimit">
              <div>
                <div class="progress-track">
                  <div class="progress-fill"
                    :class="selectedKeyQuota.tokenPercent > 90 ? 'bg-accent-red' : selectedKeyQuota.tokenPercent > 70 ? 'bg-gradient-to-r from-accent-amber to-accent-red' : 'bg-gradient-to-r from-accent-violet to-accent-teal'"
                    :style="'width:' + Math.min(selectedKeyQuota.tokenPercent, 100) + '%'"></div>
                </div>
                <p class="text-[10px] text-themed-dim mt-1">
                  <span x-text="Math.max(0, Math.round(selectedKeyQuota.tokenLimit - selectedKeyQuota.tokenUsed)).toLocaleString()"></span> remaining
                  <span x-show="selectedKeyQuota.tokenPercent >= 100" class="text-accent-red font-medium ml-1">QUOTA EXCEEDED</span>
                </p>
              </div>
            </template>
            <template x-if="!selectedKeyQuota.tokenLimit">
              <div class="progress-track">
                <div class="progress-fill bg-surface-600" style="width: 100%"></div>
              </div>
            </template>
          </div>

          <!-- Formula -->
          <div class="rounded-lg bg-surface-800/60 border border-white/[0.04] p-3">
            <p class="text-[10px] text-themed-dim leading-relaxed">
              <span class="text-themed-secondary font-medium" x-text="t('dash.tokenQuotaFormula')"></span>
              <code class="text-accent-violet ml-1">Cache Read \u00d7 10%</code> +
              <code class="text-accent-teal">Uncached Input \u00d7 100%</code> +
              <code class="text-accent-amber">Output \u00d7 500%</code>
            </p>
          </div>
        </div>
      </template>

      <!-- Web Search Panel (shown when a key is selected) -->
      <template x-if="selectedKeyId">
        <div class="glass-card p-6 mb-6 animate-in delay-1">
          <div class="flex items-center justify-between mb-4">
            <span class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.webSearch')"></span>
            <div class="flex items-center gap-2">
              <template x-if="!wsEditing">
                <button @click="startEditWebSearch()" class="btn-ghost text-xs" x-show="(isAdmin || isUser) && keys.find(k => k.id === selectedKeyId)?.is_owner !== false" x-text="t('dash.edit')"></button>
              </template>
              <template x-if="wsEditing">
                <div class="flex items-center gap-2">
                  <button @click="saveWebSearch()" class="btn-primary !text-xs !py-1 !px-3" :disabled="wsSaving">
                    <span x-show="!wsSaving" x-text="t('dash.save')"></span>
                    <span x-show="wsSaving" x-text="t('dash.saving')"></span>
                  </button>
                  <button @click="wsEditing = false" class="btn-ghost text-xs" x-text="t('dash.cancel')"></button>
                </div>
              </template>
            </div>
          </div>

          <!-- Edit form -->
          <template x-if="wsEditing">
            <div class="space-y-4 mb-4">
              <div class="flex items-center gap-6">
                <label class="flex items-center gap-2 text-xs text-themed-secondary cursor-pointer">
                  <input type="checkbox" x-model="wsEditEnabled" class="accent-accent-violet" />
                  Enable Web Search
                </label>
                <span x-show="wsEditEnabled" class="text-xs text-themed-dim">(Bing fallback always active)</span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label class="text-xs text-themed-dim block mb-1" x-text="t('dash.langSearchKey')"></label>
                  <input type="text" x-model="wsEditLangsearch" placeholder="Not set"
                    class="!text-xs !py-1.5 !px-3 w-full !rounded-lg font-mono" />
                </div>
                <div>
                  <label class="text-xs text-themed-dim block mb-1" x-text="t('dash.tavilyKey')"></label>
                  <input type="text" x-model="wsEditTavily" placeholder="Not set"
                    class="!text-xs !py-1.5 !px-3 w-full !rounded-lg font-mono" />
                </div>
              </div>
              <!-- Copy from another key -->
              <div class="flex items-center gap-2">
                <select x-model="wsCopySourceId" class="!text-xs !py-1.5 !px-3 !rounded-lg flex-1">
                  <option value="" x-text="t('dash.copyFromKey')"></option>
                  <template x-for="k in keys.filter(k => k.id !== selectedKeyId && k.web_search_enabled)" :key="k.id">
                    <option :value="k.id" x-text="k.name + (k.web_search_enabled ? ' (enabled)' : '')"></option>
                  </template>
                </select>
                <button @click="copyWebSearchFrom()" class="btn-ghost text-xs" :disabled="!wsCopySourceId" x-text="t('dash.copy')"></button>
              </div>
            </div>
          </template>

          <!-- Display current settings -->
          <template x-if="!wsEditing">
            <div class="space-y-3">
              <div class="flex items-center gap-4">
                <span class="text-xs text-themed-secondary" x-text="t('dash.status')"></span>
                <span class="text-xs font-medium" :class="wsConfig.enabled ? 'text-accent-teal' : 'text-themed-dim'"
                  x-text="wsConfig.enabled ? 'Enabled' : 'Disabled'"></span>
              </div>
              <template x-if="wsConfig.enabled">
                <div class="space-y-2">
                  <div class="flex items-center gap-4">
                    <span class="text-xs text-themed-secondary" x-text="t('dash.engines')"></span>
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] px-1.5 py-0.5 rounded" :class="wsConfig.langsearchKey ? 'bg-accent-violet/20 text-accent-violet' : 'bg-surface-600 text-themed-dim'"
                        x-text="wsConfig.langsearchKey ? 'LangSearch \u2713' : 'LangSearch'"></span>
                      <span class="text-[10px] px-1.5 py-0.5 rounded" :class="wsConfig.tavilyKey ? 'bg-accent-teal/20 text-accent-teal' : 'bg-surface-600 text-themed-dim'"
                        x-text="wsConfig.tavilyKey ? 'Tavily \u2713' : 'Tavily'"></span>
                      <span class="text-[10px] px-1.5 py-0.5 rounded" :class="wsConfig.enabled ? 'bg-accent-amber/20 text-accent-amber' : 'bg-surface-600 text-themed-dim'"
                        x-text="wsConfig.enabled ? 'Bing \u2713' : 'Bing'"></span>
                    </div>
                  </div>
                  <!-- Today's usage -->
                  <div class="flex items-center gap-4">
                    <span class="text-xs text-themed-secondary" x-text="t('dash.today')"></span>
                    <span class="text-xs font-mono text-themed" x-text="wsUsage.searches + ' searches'"></span>
                    <span class="text-[10px] text-accent-teal" x-text="wsUsage.successes + ' ok'"></span>
                    <span class="text-[10px] text-accent-red" x-show="wsUsage.failures > 0" x-text="wsUsage.failures + ' failed'"></span>
                  </div>
                </div>
              </template>
            </div>
          </template>
        </div>
      </template>

      <div class="glass-card p-6 animate-in delay-1">
        <span class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.configuration')"></span>
        <template x-if="selectedKeyId">
          <p class="text-xs text-accent-violet mt-2 flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
            Configs below use the selected key.
          </p>
        </template>

        <template x-if="modelsLoaded">
          <div class="mt-4">
            <div class="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5 mb-5">
              <button @click="configTab='claude'" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="configTab === 'claude' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'" x-text="t('dash.claudeCode')"></button>
              <button @click="configTab='codex'" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="configTab === 'codex' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'" x-text="t('dash.codex')"></button>
              <button @click="configTab='gemini'" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="configTab === 'gemini' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'" x-text="t('dash.geminiCli')"></button>
            </div>

            <!-- Claude Code -->
            <div x-show="configTab === 'claude'" x-transition>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div class="flex items-center gap-2">
                  <label class="text-xs text-themed-dim" x-text="t('dash.model')"></label>
                  <select x-model="claudeModel" class="text-xs font-mono bg-surface-800 text-themed-secondary border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-violet/50 cursor-pointer">
                    <template x-for="m in claudeModelsBig" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
              </div>
              <p class="text-[11px] text-themed-dim mb-2">Add to <code class="text-themed-dim">~/.bashrc</code> or <code class="text-themed-dim">~/.zshrc</code></p>
              ${codeBlock("bash", "claudeCode", "claudeCodeSnippet", "claude")}
            </div>

            <!-- Codex -->
            <div x-show="configTab === 'codex'" x-transition>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div class="flex items-center gap-2">
                  <label class="text-xs text-themed-dim" x-text="t('dash.model')"></label>
                  <select x-model="codexModel" class="text-xs font-mono bg-surface-800 text-themed-secondary border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-violet/50 cursor-pointer">
                    <template x-for="m in codexModels" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
              </div>
              <p class="text-[11px] text-themed-dim mb-2">1. Add to <code class="text-themed-dim">~/.codex/config.toml</code></p>
              ${codeBlock("toml", "codexToml", "codexSnippet", "codex-toml")}
              <p class="text-[11px] text-themed-dim mb-2 mt-4">2. Add to <code class="text-themed-dim">~/.bashrc</code> or <code class="text-themed-dim">~/.zshrc</code></p>
              ${codeBlock("bash", "codexEnv", "codexEnvSnippet", "codex-env")}
              <p class="text-[11px] text-themed-dim mb-2 mt-4">3. Start Codex</p>
              ${codeBlock("bash", "codexStart", "codexStartSnippet", "codex-start")}
            </div>

            <!-- Gemini CLI -->
            <div x-show="configTab === 'gemini'" x-transition>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div class="flex items-center gap-2">
                  <label class="text-xs text-themed-dim" x-text="t('dash.model')"></label>
                  <select x-model="geminiModel" class="text-xs font-mono bg-surface-800 text-themed-secondary border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-violet/50 cursor-pointer">
                    <template x-for="m in geminiModels" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
              </div>
              <p class="text-[11px] text-themed-dim mb-2">Add to <code class="text-themed-dim">~/.bashrc</code> or <code class="text-themed-dim">~/.zshrc</code></p>
              ${codeBlock("bash", "geminiEnv", "geminiSnippet", "gemini-env")}
            </div>
          </div>
        </template>
      </div>
    </div>
  `
}

export function renderUsageTab(): string {
  return `
    <div x-show="tab === 'usage'">
      <div class="glass-card p-6 animate-in">
        <div class="flex flex-col gap-4 mb-6">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div class="flex items-center gap-3">
              <span class="text-xs font-medium text-themed-dim uppercase tracking-widest">Token Usage</span>
              <template x-if="tokenLoading">
                <svg class="animate-spin h-3.5 w-3.5 text-themed-dim" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
              </template>
            </div>
            <div class="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
              <button @click="switchTokenRange('today')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="tokenRange === 'today' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'" x-text="t('dash.today')"></button>
              <button @click="switchTokenRange('week')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="tokenRange === 'week' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'" x-text="t('dash.week')"></button>
              <button @click="switchTokenRange('7d')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="tokenRange === '7d' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'" x-text="t('dash.sevenDays')"></button>
              <button @click="switchTokenRange('30d')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="tokenRange === '30d' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'" x-text="t('dash.thirtyDays')"></button>
            </div>
          </div>

          <!-- Week navigator -->
          <div x-show="tokenRange === 'week'" class="flex items-center gap-3 ml-1">
            <button @click="shiftWeek(-1)" class="p-1 rounded hover:bg-surface-600 text-themed-dim hover:text-themed transition-all" :title="t('dash.previousWeek')">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
            </button>
            <span class="text-xs text-themed-secondary font-medium min-w-[180px] text-center" x-text="weekLabel()"></span>
            <button @click="shiftWeek(1)" :disabled="tokenWeekOffset >= 0"
              class="p-1 rounded transition-all"
              :class="tokenWeekOffset >= 0 ? 'text-themed-dim/30 cursor-not-allowed' : 'hover:bg-surface-600 text-themed-dim hover:text-themed'" :title="t('dash.nextWeek')">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
            </button>
          </div>

          <!-- Multi-dimension filters -->
          <div class="flex flex-wrap items-center gap-3">
            <template x-if="isAdmin && tokenAvailableUsers.length > 0">
              <div class="flex items-center gap-2 w-full sm:w-auto">
                <label class="text-[11px] text-themed-dim uppercase tracking-wide shrink-0 w-12 sm:w-auto" x-text="t('dash.user')"></label>
                <select x-model="tokenFilterUser" @change="switchTokenFilter()"
                  class="bg-surface-800 border border-white/10 text-themed-secondary text-xs rounded-md px-2.5 py-1.5 focus:border-accent-violet/50 focus:outline-none min-w-0 sm:min-w-[120px] flex-1 sm:flex-none">
                  <option value="" x-text="t('dash.allUsers')"></option>
                  <template x-for="u in tokenAvailableUsers" :key="u.id">
                    <option :value="u.id" x-text="u.name"></option>
                  </template>
                </select>
              </div>
            </template>
            <div class="flex items-center gap-2 w-full sm:w-auto">
              <label class="text-[11px] text-themed-dim uppercase tracking-wide shrink-0 w-12 sm:w-auto" x-text="t('dash.key')"></label>
              <select x-model="tokenFilterKey" @change="switchTokenFilter()"
                class="bg-surface-800 border border-white/10 text-themed-secondary text-xs rounded-md px-2.5 py-1.5 focus:border-accent-violet/50 focus:outline-none min-w-0 sm:min-w-[120px] flex-1 sm:flex-none">
                <option value="" x-text="t('dash.allKeys')"></option>
                <template x-for="k in tokenAvailableKeys" :key="k.id">
                  <option :value="k.id" x-text="k.name"></option>
                </template>
              </select>
            </div>
            <div class="flex items-center gap-2 w-full sm:w-auto">
              <label class="text-[11px] text-themed-dim uppercase tracking-wide shrink-0 w-12 sm:w-auto" x-text="t('dash.client')"></label>
              <select x-model="tokenFilterClient" @change="switchTokenFilter()"
                class="bg-surface-800 border border-white/10 text-themed-secondary text-xs rounded-md px-2.5 py-1.5 focus:border-accent-violet/50 focus:outline-none min-w-0 sm:min-w-[120px] flex-1 sm:flex-none">
                <option value="" x-text="t('dash.allClients')"></option>
                <template x-for="c in tokenAvailableClients" :key="c">
                  <option :value="c" x-text="c"></option>
                </template>
              </select>
            </div>
            <div class="flex items-center gap-2 w-full sm:w-auto">
              <label class="text-[11px] text-themed-dim uppercase tracking-wide shrink-0 w-12 sm:w-auto" x-text="t('dash.model')"></label>
              <select x-model="tokenFilterModel" @change="switchTokenFilter()"
                class="bg-surface-800 border border-white/10 text-themed-secondary text-xs rounded-md px-2.5 py-1.5 focus:border-accent-violet/50 focus:outline-none min-w-0 sm:min-w-[120px] flex-1 sm:flex-none">
                <option value="" x-text="t('dash.allModels')"></option>
                <template x-for="m in tokenAvailableModels" :key="m">
                  <option :value="m" x-text="m"></option>
                </template>
              </select>
            </div>
            <button @click="tokenFilterKey = ''; tokenFilterClient = ''; tokenFilterModel = ''; tokenFilterUser = ''; switchTokenFilter()"
              x-show="tokenFilterKey || tokenFilterClient || tokenFilterModel || tokenFilterUser"
              class="text-[11px] text-themed-dim hover:text-themed-secondary transition-colors px-2 py-1" x-text="t('dash.clearFilters')"></button>
          </div>

          <!-- Filter hint -->
          <p class="text-[11px] text-themed-dim" x-show="tokenData.length > 0"
            x-text="(() => {
              const selected = [];
              const all = [];
              if (isAdmin && tokenAvailableUsers.length > 0) {
                if (tokenFilterUser) selected.push('User: ' + (tokenAvailableUsers.find(u => u.id === tokenFilterUser)?.name || tokenFilterUser.slice(0,8)));
                else all.push('User');
              }
              if (tokenFilterKey) selected.push('Key: ' + (tokenAvailableKeys.find(k => k.id === tokenFilterKey)?.name || tokenFilterKey.slice(0,8)));
              else all.push('Key');
              if (tokenFilterClient) selected.push('Client: ' + tokenFilterClient);
              else all.push('Client');
              if (tokenFilterModel) selected.push('Model: ' + tokenFilterModel);
              else all.push('Model');
              if (selected.length === 0) return 'Showing overall usage. Select a filter to see distribution by the remaining dimensions.';
              if (all.length === 0) return 'Filtered by ' + selected.join(', ') + '.';
              return 'Filtered by ' + selected.join(', ') + '. Showing distribution by ' + all.join(' & ') + '.';
            })()"></p>
        </div>

        <div style="height: 320px; position: relative;">
          <template x-if="tokenLoading && !tokenChart">
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="flex flex-col items-center gap-3">
                <svg class="animate-spin h-6 w-6 text-accent-violet/60" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
                <span class="text-xs text-themed-dim" x-text="t('dash.loadingUsage')"></span>
              </div>
            </div>
          </template>
          <canvas id="tokenChart"></canvas>
        </div>

        <p class="text-[10px] text-themed-dim mb-2" x-text="t('dash.utcNote')"></p>
        <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4 mt-6 pt-5 border-t border-white/5">
          <div class="text-center">
            <p class="text-xs text-themed-dim mb-1" x-text="t('dash.requests')"></p>
            <p class="text-lg font-bold font-mono text-themed" x-text="tokenSummary.requests.toLocaleString()"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-themed-dim mb-1" x-text="t('dash.totalInput')"></p>
            <p class="text-lg font-bold font-mono text-themed" x-text="(tokenSummary.input + tokenSummary.cacheRead + tokenSummary.cacheCreation).toLocaleString()"></p>
            <p class="text-[10px] text-themed-dim mt-0.5" x-text="t('dash.totalInputNote')"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-themed-dim mb-1" x-text="t('dash.cacheRead')"></p>
            <p class="text-lg font-bold font-mono text-green-400" x-text="tokenSummary.cacheRead.toLocaleString()"></p>
            <p class="text-[10px] text-themed-dim mt-0.5"
              x-text="(() => { const total = tokenSummary.input + tokenSummary.cacheRead + tokenSummary.cacheCreation; return total > 0 ? (tokenSummary.cacheRead / total * 100).toFixed(1) + '% hit' : ''; })()"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-themed-dim mb-1" x-text="t('dash.cacheCreation')"></p>
            <p class="text-lg font-bold font-mono text-themed" x-text="tokenSummary.cacheCreation.toLocaleString()"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-themed-dim mb-1" x-text="t('dash.uncachedInput')"></p>
            <p class="text-lg font-bold font-mono text-themed" x-text="tokenSummary.input.toLocaleString()"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-themed-dim mb-1" x-text="t('dash.outputTokens')"></p>
            <p class="text-lg font-bold font-mono text-themed" x-text="tokenSummary.output.toLocaleString()"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-themed-dim mb-1" x-text="t('dash.totalTokens')"></p>
            <p class="text-lg font-bold font-mono text-themed"
               x-text="(tokenSummary.input + tokenSummary.output + tokenSummary.cacheRead + tokenSummary.cacheCreation).toLocaleString()"></p>
          </div>
        </div>
      </div>

      ${renderDistributionPanel('tokenByModel', 'dash.byModel', 'label')}
      ${renderDistributionPanel('tokenByUser', 'dash.byUser', 'label')}
      ${renderDistributionPanel('tokenByKey', 'dash.byKey', 'label')}
      ${renderDistributionPanel('tokenByClient', 'dash.byClient', 'label')}
    </div>
  `
}

function renderDistributionPanel(dataVar: string, titleKey: string, labelField: string): string {
  return `
      <div class="glass-card p-6 mt-5 animate-in delay-1" x-show="${dataVar}.length > 0">
        <span class="text-xs font-medium text-themed-dim uppercase tracking-widest mb-4 block" x-text="t('${titleKey}')"></span>

        <!-- Stacked horizontal bars -->
        <div class="space-y-3 mb-6" @mouseleave="hoveredDist = null">
          <div>
            <p class="text-[11px] text-themed-dim mb-1.5" x-text="t('dash.requests')"></p>
            <div class="flex h-[14px] gap-[2px] rounded-full overflow-hidden">
              <template x-for="(m, i) in ${dataVar}" :key="'${dataVar}-req-'+m.${labelField}">
                <div class="h-full transition-all duration-200 cursor-pointer"
                  @mouseenter="hoveredDist = '${dataVar}:' + m.${labelField}"
                  :title="m.${labelField} + ': ' + distPercent(${dataVar}, 'requests')[i] + '%'"
                  :style="'width:' + distPercent(${dataVar}, 'requests')[i] + '%;background:' + modelColors[i % modelColors.length] + ';opacity:' + (hoveredDist && hoveredDist !== '${dataVar}:' + m.${labelField} ? '0.25' : '0.85')"
                  x-show="distPercent(${dataVar}, 'requests')[i] > 0">
                </div>
              </template>
            </div>
          </div>
          <div>
            <p class="text-[11px] text-themed-dim mb-1.5" x-text="t('dash.input')"></p>
            <div class="flex h-[14px] gap-[2px] rounded-full overflow-hidden">
              <template x-for="(m, i) in ${dataVar}" :key="'${dataVar}-in-'+m.${labelField}">
                <div class="h-full transition-all duration-200 cursor-pointer"
                  @mouseenter="hoveredDist = '${dataVar}:' + m.${labelField}"
                  :title="m.${labelField} + ': ' + distPercent(${dataVar}, 'input')[i] + '%'"
                  :style="'width:' + distPercent(${dataVar}, 'input')[i] + '%;background:' + modelColors[i % modelColors.length] + ';opacity:' + (hoveredDist && hoveredDist !== '${dataVar}:' + m.${labelField} ? '0.25' : '0.85')"
                  x-show="distPercent(${dataVar}, 'input')[i] > 0">
                </div>
              </template>
            </div>
          </div>
          <div>
            <p class="text-[11px] text-themed-dim mb-1.5" x-text="t('dash.output')"></p>
            <div class="flex h-[14px] gap-[2px] rounded-full overflow-hidden">
              <template x-for="(m, i) in ${dataVar}" :key="'${dataVar}-out-'+m.${labelField}">
                <div class="h-full transition-all duration-200 cursor-pointer"
                  @mouseenter="hoveredDist = '${dataVar}:' + m.${labelField}"
                  :title="m.${labelField} + ': ' + distPercent(${dataVar}, 'output')[i] + '%'"
                  :style="'width:' + distPercent(${dataVar}, 'output')[i] + '%;background:' + modelColors[i % modelColors.length] + ';opacity:' + (hoveredDist && hoveredDist !== '${dataVar}:' + m.${labelField} ? '0.25' : '0.85')"
                  x-show="distPercent(${dataVar}, 'output')[i] > 0">
                </div>
              </template>
            </div>
          </div>
          <!-- Hover detail -->
          <div class="h-5 flex items-center">
            <template x-if="hoveredDist && hoveredDist.startsWith('${dataVar}:')">
              <p class="text-xs text-themed-secondary font-mono" x-text="(() => { const label = hoveredDist.slice('${dataVar}:'.length); const idx = ${dataVar}.findIndex(x => x.${labelField} === label); const m = idx >= 0 ? ${dataVar}[idx] : null; if (!m) return ''; const rp = distPercent(${dataVar}, 'requests')[idx]; const ip = distPercent(${dataVar}, 'input')[idx]; const op = distPercent(${dataVar}, 'output')[idx]; return m.${labelField} + '  \\u2014  ' + rp + '% reqs \\u00b7 ' + ip + '% in \\u00b7 ' + op + '% out'; })()"></p>
            </template>
          </div>
          <!-- Legend -->
          <div class="flex flex-wrap gap-x-5 gap-y-2">
            <template x-for="(m, i) in ${dataVar}" :key="'${dataVar}-leg-'+m.${labelField}">
              <div class="flex items-center gap-2 cursor-pointer transition-opacity duration-150"
                @mouseenter="hoveredDist = '${dataVar}:' + m.${labelField}" @mouseleave="hoveredDist = null"
                :style="'opacity:' + (hoveredDist && hoveredDist !== '${dataVar}:' + m.${labelField} ? '0.35' : '1')">
                <span class="w-2 h-2 rounded-full shrink-0" :style="'background:' + modelColors[i % modelColors.length]"></span>
                <span class="text-[11px] text-themed-secondary" x-text="m.${labelField}"></span>
              </div>
            </template>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-sm whitespace-nowrap">
            <thead>
              <tr class="border-b" style="border-color: var(--border-color)">
                <th class="text-left py-2.5 pr-4 text-[11px] font-medium text-themed-dim uppercase tracking-widest" x-text="t('${titleKey}')"></th>
                <th class="text-right py-2.5 pr-4 text-[11px] font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.requests')"></th>
                <th class="text-right py-2.5 pr-4 text-[11px] font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.input')"></th>
                <th class="text-right py-2.5 pr-4 text-[11px] font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.output')"></th>
                <th class="text-right py-2.5 pr-4 text-[11px] font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.cacheRead')"></th>
                <th class="text-right py-2.5 pr-4 text-[11px] font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.cacheCreation')"></th>
                <th class="text-right py-2.5 text-[11px] font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.totalTokens')"></th>
              </tr>
            </thead>
            <tbody>
              <template x-for="(m, i) in ${dataVar}" :key="'${dataVar}-row-'+m.${labelField}">
                <tr class="transition-all duration-150 cursor-pointer border-b" style="border-color: var(--border-color)"
                  @mouseenter="hoveredDist = '${dataVar}:' + m.${labelField}" @mouseleave="hoveredDist = null"
                  :class="hoveredDist === '${dataVar}:' + m.${labelField} ? 'bg-surface-700/50' : (hoveredDist && hoveredDist.startsWith('${dataVar}:') ? 'opacity-40' : '')">
                  <td class="py-2.5 pr-4">
                    <span class="inline-flex items-center gap-2">
                      <span class="w-2 h-2 rounded-full shrink-0" :style="'background:' + modelColors[i % modelColors.length]"></span>
                      <span class="text-xs text-themed" x-text="m.${labelField}"></span>
                    </span>
                  </td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="m.requests.toLocaleString()"></td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="m.input.toLocaleString()"></td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="m.output.toLocaleString()"></td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="m.cacheRead.toLocaleString()"></td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="m.cacheCreation.toLocaleString()"></td>
                  <td class="py-2.5 text-right text-themed-secondary font-mono text-xs" x-text="(m.input + m.output + m.cacheRead + m.cacheCreation).toLocaleString()"></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
  `
}

export function renderLatencyTab(): string {
  return `
    <div x-show="tab === 'latency'">
      <div class="glass-card p-6 animate-in">
        <div class="flex flex-col gap-4 mb-6">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div class="flex items-center gap-3">
              <span class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.latency')"></span>
              <template x-if="latencyLoading">
                <svg class="animate-spin h-3.5 w-3.5 text-themed-dim" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
              </template>
            </div>
            <div class="flex items-center gap-3 flex-wrap">
              <div class="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
                <button @click="switchLatencyRange('today')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                  :class="latencyRange === 'today' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'" x-text="t('dash.today')"></button>
                <button @click="switchLatencyRange('week')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                  :class="latencyRange === 'week' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'" x-text="t('dash.week')"></button>
                <button @click="switchLatencyRange('7d')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                  :class="latencyRange === '7d' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'" x-text="t('dash.sevenDays')"></button>
                <button @click="switchLatencyRange('30d')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                  :class="latencyRange === '30d' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'" x-text="t('dash.thirtyDays')"></button>
              </div>
              <template x-if="latencyModels.length > 0">
                <select @change="switchLatencyModel($event.target.value)" x-model="latencyModel"
                  class="text-xs font-mono bg-surface-800 text-themed-secondary border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-violet/50 cursor-pointer">
                  <option value="" x-text="t('dash.allModels')"></option>
                  <template x-for="m in latencyModels" :key="m">
                    <option :value="m" x-text="m"></option>
                  </template>
                </select>
              </template>
            </div>
          </div>

          <!-- Week navigator -->
          <div x-show="latencyRange === 'week'" class="flex items-center gap-3 ml-1">
            <button @click="shiftLatencyWeek(-1)" class="p-1 rounded hover:bg-surface-600 text-themed-dim hover:text-themed transition-all" :title="t('dash.previousWeek')">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
            </button>
            <span class="text-xs text-themed-secondary font-medium min-w-[180px] text-center" x-text="latencyWeekLabel()"></span>
            <button @click="shiftLatencyWeek(1)" :disabled="latencyWeekOffset >= 0"
              class="p-1 rounded transition-all"
              :class="latencyWeekOffset >= 0 ? 'text-themed-dim/30 cursor-not-allowed' : 'hover:bg-surface-600 text-themed-dim hover:text-themed'" :title="t('dash.nextWeek')">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
            </button>
          </div>
        </div>

        <div style="height: 320px; position: relative;">
          <template x-if="latencyLoading && !latencyChart">
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="flex flex-col items-center gap-3">
                <svg class="animate-spin h-6 w-6 text-accent-violet/60" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
                <span class="text-xs text-themed-dim" x-text="t('dash.loadingLatency')"></span>
              </div>
            </div>
          </template>
          <canvas id="latencyChart"></canvas>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 pt-5 border-t border-white/5">
          <div class="text-center">
            <p class="text-xs text-themed-dim mb-1" x-text="t('dash.avgTotal')"></p>
            <p class="text-lg font-bold font-mono text-themed" x-text="latencySummary.avgTotal + ' ms'"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-themed-dim mb-1" x-text="t('dash.avgUpstream')"></p>
            <p class="text-lg font-bold font-mono text-themed" x-text="latencySummary.avgUpstream + ' ms'"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-themed-dim mb-1" x-text="t('dash.avgTtfb')"></p>
            <p class="text-lg font-bold font-mono text-themed" x-text="latencySummary.avgTtfb + ' ms'"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-themed-dim mb-1">Token Miss Rate</p>
            <p class="text-lg font-bold font-mono" :class="latencySummary.tokenMissRate > 50 ? 'text-accent-red' : latencySummary.tokenMissRate > 20 ? 'text-accent-amber' : 'text-accent-teal'" x-text="latencySummary.tokenMissRate + '%'"></p>
          </div>
        </div>
      </div>

      <div class="glass-card p-6 mt-5 animate-in delay-1" x-show="latencyByType.length > 0">
        <span class="text-xs font-medium text-themed-dim uppercase tracking-widest mb-4 block">By Type</span>
        <div class="overflow-x-auto">
          <table class="w-full text-sm whitespace-nowrap">
            <thead>
              <tr class="border-b border-white/5">
                <th class="text-left py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest">Type</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest">Requests</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest">Avg Total</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest">Avg Upstream</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest">Avg TTFB</th>
                <th class="text-right py-2 text-xs font-medium text-themed-dim uppercase tracking-widest">Token Miss</th>
              </tr>
            </thead>
            <tbody>
              <template x-for="t in latencyByType" :key="t.type">
                <tr class="border-b border-white/[0.03]">
                  <td class="py-2.5 pr-4"><code class="text-xs font-mono" :class="t.type === 'Stream' ? 'text-accent-violet' : 'text-accent-amber'" x-text="t.type"></code></td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="t.requests.toLocaleString()"></td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="t.avgTotal + ' ms'"></td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="t.avgUpstream + ' ms'"></td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="t.avgTtfb + ' ms'"></td>
                  <td class="py-2.5 text-right font-mono text-xs" :class="t.tokenMissRate > 50 ? 'text-accent-red' : t.tokenMissRate > 20 ? 'text-accent-amber' : 'text-accent-teal'" x-text="t.tokenMissRate + '%'"></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>

      <div class="glass-card p-6 mt-5 animate-in delay-1" x-show="latencyByColo.length > 0">
        <span class="text-xs font-medium text-themed-dim uppercase tracking-widest mb-4 block">By Data Center</span>
        <div class="overflow-x-auto">
          <table class="w-full text-sm whitespace-nowrap">
            <thead>
              <tr class="border-b border-white/5">
                <th class="text-left py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest">Colo</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest">Requests</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest">Avg Total</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest">Avg Upstream</th>
                <th class="text-right py-2 text-xs font-medium text-themed-dim uppercase tracking-widest">Token Miss</th>
              </tr>
            </thead>
            <tbody>
              <template x-for="c in latencyByColo" :key="c.colo">
                <tr class="border-b border-white/[0.03]">
                  <td class="py-2.5 pr-4"><code class="text-xs font-mono text-accent-violet" x-text="c.colo"></code></td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="c.requests.toLocaleString()"></td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="c.avgTotal + ' ms'"></td>
                  <td class="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs" x-text="c.avgUpstream + ' ms'"></td>
                  <td class="py-2.5 text-right font-mono text-xs" :class="c.tokenMissRate > 50 ? 'text-accent-red' : c.tokenMissRate > 20 ? 'text-accent-amber' : 'text-accent-teal'" x-text="c.tokenMissRate + '%'"></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `
}

export function renderSettingsTab(): string {
  return `
    <template x-if="isAdmin">
      <div x-show="tab === 'settings'" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100">
        <div class="glass-card p-6 mb-6 animate-in">
          <h3 class="text-themed font-semibold mb-1">Export Data</h3>
          <p class="text-sm text-themed-secondary mb-4">Download all API keys, GitHub accounts, and usage data as a JSON file.</p>
          <button @click="exportData()" class="btn-primary" :disabled="exportLoading">
            <span x-show="!exportLoading" class="flex items-center gap-2">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export JSON
            </span>
            <span x-show="exportLoading" class="flex items-center gap-2">
              <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
              </svg>
              Exporting...
            </span>
          </button>
        </div>
      </div>
    </template>
  `
}

export function renderClientsTab(): string {
  return `
    <template x-if="isAdmin || isUser">
      <div x-show="tab === 'relays'" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100">
        <div class="glass-card p-6 animate-in">
          <div class="flex items-center justify-between mb-4">
            <span class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.relayClients')"></span>
            <button @click="loadRelays()" class="btn-ghost text-xs" :disabled="relaysLoading">
              <svg :class="relaysLoading ? 'animate-spin' : ''" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>
          </div>

          <div x-show="relaysLoading && relays.length === 0" class="text-center py-8 text-themed-dim text-sm" x-text="t('common.loading')"></div>
          <div x-show="!relaysLoading && relays.length === 0" class="text-center py-8 text-themed-dim text-sm" x-text="t('dash.noRelays')"></div>

          <div x-show="relays.length > 0" class="space-y-2">
            <template x-for="c in relays" :key="c.clientId">
              <div class="flex items-center justify-between gap-3 p-4 rounded-lg bg-surface-800/50 border border-white/[0.04]">
                <div class="flex items-center gap-3 min-w-0 flex-1">
                  <div class="relative shrink-0">
                    <div class="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center">
                      <svg class="w-4 h-4 text-themed-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
                      </svg>
                    </div>
                    <div class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-surface-800"
                      :class="c.isActive ? 'bg-accent-teal status-pulse' : c.isOnline ? 'bg-accent-violet' : 'bg-surface-600'"></div>
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-sm font-medium text-themed truncate" x-text="c.clientName"></span>
                      <template x-if="c.isActive">
                        <span class="shrink-0 text-[10px] font-medium text-accent-teal uppercase tracking-widest" x-text="t('dash.active')"></span>
                      </template>
                      <template x-if="!c.isActive && c.isOnline">
                        <span class="shrink-0 text-[10px] font-medium text-accent-violet uppercase tracking-widest" x-text="t('dash.online')"></span>
                      </template>
                      <template x-if="!c.isOnline">
                        <span class="shrink-0 text-[10px] font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.offline')"></span>
                      </template>
                    </div>
                    <div class="flex items-center gap-x-3 gap-y-1 mt-0.5 flex-wrap min-w-0">
                      <template x-if="c.keyName">
                        <span class="text-xs text-themed-dim flex items-center gap-1 min-w-0">
                          <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                          </svg>
                          <span class="truncate" x-text="c.keyName"></span>
                        </span>
                      </template>
                      <template x-if="isAdmin && c.ownerId">
                        <span class="text-xs text-themed-dim truncate" x-text="'owner: ' + (c.ownerName || c.ownerId.slice(0, 8))"></span>
                      </template>
                      <template x-if="c.gatewayUrl">
                        <span class="text-xs text-themed-dim font-mono truncate max-w-full sm:max-w-[160px]" :title="c.gatewayUrl" x-text="c.gatewayUrl.replace(/https?:\\/\\//, '')"></span>
                      </template>
                    </div>
                  </div>
                </div>
                <div class="text-right shrink-0">
                  <span class="text-xs text-themed-dim whitespace-nowrap" :title="c.lastSeenAt" x-text="timeAgo(c.lastSeenAt)"></span>
                </div>
              </div>
            </template>
          </div>

          <p class="text-[11px] text-themed-dim mt-4">
            <span class="text-accent-teal">Active</span> — routed traffic in the last 2 hours &nbsp;·&nbsp;
            <span class="text-accent-violet">Online</span> — heartbeat received, no recent traffic &nbsp;·&nbsp;
            <span class="text-themed-dim">Offline</span> — no heartbeat in 3 minutes
          </p>
        </div>
      </div>
    </template>
  `
}
