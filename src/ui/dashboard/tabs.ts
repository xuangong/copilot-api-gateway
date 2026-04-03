// Dashboard tabs HTML templates

function codeBlock(lang: string, ref: string, snippetFn: string, copyId: string): string {
  return `
    <div class="relative group">
      <pre class="bg-surface-900 rounded-xl p-4 pr-10 overflow-x-auto border border-white/[0.04]"><code class="language-${lang}" x-ref="${ref}" x-effect="$el.textContent = ${snippetFn}(); Prism.highlightElement($el)"></code></pre>
      <button
        @click="copySnippet(${snippetFn}(), '${copyId}')"
        class="absolute top-2.5 right-2.5 p-1.5 rounded-md bg-surface-700/80 text-gray-500 hover:text-accent-cyan hover:bg-surface-600 transition-all opacity-0 group-hover:opacity-100"
        :title="copied === '${copyId}' ? 'Copied!' : 'Copy'"
      >
        <svg x-show="copied !== '${copyId}'" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <svg x-show="copied === '${copyId}'" class="w-3.5 h-3.5 text-accent-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
    </div>
  `
}

export function renderDashboardHeader(): string {
  return `
    <header class="border-b border-white/5 bg-surface-900/80 backdrop-blur-md sticky top-0 z-50">
      <div class="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-surface-700 glow-border flex items-center justify-center">
            <svg class="w-4 h-4 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span class="font-semibold text-white text-sm tracking-tight">Copilot Gateway</span>
        </div>
        <button @click="logout()" class="btn-ghost text-xs">Logout</button>
      </div>

      <div class="max-w-6xl mx-auto px-6 pb-3">
        <nav class="flex gap-1 bg-surface-800 rounded-lg p-0.5 w-fit">
          <template x-if="isAdmin || isUser">
            <button @click="switchTab('upstream')" class="px-4 py-2 rounded-md text-sm font-medium transition-all"
              :class="tab === 'upstream' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
              Upstream
            </button>
          </template>
          <template x-if="isAdmin">
            <button @click="switchTab('users')" class="px-4 py-2 rounded-md text-sm font-medium transition-all"
              :class="tab === 'users' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
              Users
            </button>
          </template>
          <button @click="switchTab('keys')" class="px-4 py-2 rounded-md text-sm font-medium transition-all"
            :class="tab === 'keys' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
            API Keys
          </button>
          <button @click="switchTab('usage')" class="px-4 py-2 rounded-md text-sm font-medium transition-all"
            :class="tab === 'usage' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
            Usage
          </button>
          <button @click="switchTab('latency')" class="px-4 py-2 rounded-md text-sm font-medium transition-all"
            :class="tab === 'latency' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
            Latency
          </button>
          <template x-if="isAdmin">
            <button @click="switchTab('settings')" class="px-4 py-2 rounded-md text-sm font-medium transition-all"
              :class="tab === 'settings' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
              Settings
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
        <h2 class="text-lg font-semibold text-white mb-4">Invite Codes</h2>
        <div class="flex gap-3 mb-4">
          <input type="text" x-model="newInviteName" placeholder="User name for invite..." class="flex-1" @keydown.enter="createInviteCode()" />
          <button @click="createInviteCode()" class="btn-primary text-sm" :disabled="inviteCreating || !newInviteName.trim()">
            <span x-show="!inviteCreating">Create Invite</span>
            <span x-show="inviteCreating">Creating...</span>
          </button>
        </div>

        <div x-show="inviteCodesLoading" class="text-center py-4 text-gray-500 text-sm">Loading...</div>
        <div x-show="!inviteCodesLoading && inviteCodes.length === 0" class="text-center py-4 text-gray-600 text-sm">No invite codes yet</div>

        <div x-show="!inviteCodesLoading && inviteCodes.length > 0" class="space-y-2">
          <template x-for="inv in inviteCodes" :key="inv.id">
            <div class="flex items-center justify-between p-3 rounded-lg bg-surface-800/50 border border-white/[0.04]">
              <div class="flex items-center gap-4">
                <span class="text-sm font-medium text-white" x-text="inv.name"></span>
                <template x-if="!inv.usedAt">
                  <span class="px-2 py-0.5 rounded text-xs font-mono bg-accent-cyan/10 text-accent-cyan cursor-pointer" @click="copySnippet(inv.code, 'inv-' + inv.id)" x-text="inv.code"></span>
                </template>
                <template x-if="inv.usedAt">
                  <span class="px-2 py-0.5 rounded text-xs bg-accent-emerald/10 text-accent-emerald">Used</span>
                </template>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-xs text-gray-600" x-text="timeAgo(inv.createdAt)"></span>
                <template x-if="!inv.usedAt">
                  <button @click="deleteInviteCode(inv.id)" class="text-gray-600 hover:text-accent-rose transition-colors">
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  </button>
                </template>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Users List -->
      <div class="glass-card p-6">
        <h2 class="text-lg font-semibold text-white mb-4">Users</h2>
        <div x-show="adminUsersLoading" class="text-center py-4 text-gray-500 text-sm">Loading...</div>
        <div x-show="!adminUsersLoading && adminUsers.length === 0" class="text-center py-8 text-gray-600 text-sm">No users yet. Create an invite code above.</div>

        <div x-show="!adminUsersLoading && adminUsers.length > 0" class="space-y-2">
          <template x-for="u in adminUsers" :key="u.id">
            <div class="flex items-center justify-between p-4 rounded-lg bg-surface-800/50 border border-white/[0.04]">
              <div class="flex items-center gap-4">
                <template x-if="u.githubAccounts && u.githubAccounts.length > 0">
                  <img :src="u.githubAccounts[0].avatar_url" class="w-8 h-8 rounded-full" />
                </template>
                <template x-if="!u.githubAccounts || u.githubAccounts.length === 0">
                  <div class="w-8 h-8 rounded-full bg-surface-700 flex items-center justify-center text-gray-500 text-xs">?</div>
                </template>
                <div>
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-white" x-text="u.name"></span>
                    <template x-if="u.disabled">
                      <span class="px-1.5 py-0.5 rounded text-[10px] bg-accent-rose/10 text-accent-rose uppercase">Disabled</span>
                    </template>
                  </div>
                  <div class="flex items-center gap-3 mt-0.5">
                    <template x-for="gh in (u.githubAccounts || [])" :key="gh.id">
                      <span class="text-xs text-gray-500" x-text="'@' + gh.login"></span>
                    </template>
                    <span class="text-xs text-gray-600" x-text="u.keyCount + ' key' + (u.keyCount !== 1 ? 's' : '')"></span>
                    <span class="text-xs text-gray-600" x-text="'Joined ' + timeAgo(u.createdAt)"></span>
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button @click="toggleUser(u.id, u.disabled)" class="btn-ghost text-xs" x-text="u.disabled ? 'Enable' : 'Disable'"></button>
                <button @click="deleteUser(u.id, u.name)" class="btn-ghost text-xs text-accent-rose hover:bg-accent-rose/10">Delete</button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  `
}

export function renderUpstreamTab(): string {
  return `
    <template x-if="isAdmin">
      <div x-show="tab === 'upstream'" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100">
        <template x-if="meLoaded && githubAccounts.length === 0">
          <div class="glass-card p-6 mb-8 glow-border animate-in flex items-center justify-between">
            <div>
              <h3 class="text-white font-medium mb-1">Connect GitHub Account</h3>
              <p class="text-sm text-gray-400">Link your GitHub account to use Copilot API with your own token.</p>
            </div>
            <button @click="startGithubAuth()" class="btn-primary" :disabled="deviceFlow.loading">
              <span x-show="!deviceFlow.loading">Connect GitHub</span>
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
            <div class="glass-card p-8 max-w-md w-full mx-4 glow-cyan">
              <h3 class="text-white text-lg font-semibold mb-2">GitHub Authorization</h3>
              <p class="text-gray-400 text-sm mb-6">Enter this code on GitHub to authorize:</p>
              <div class="bg-surface-900 rounded-xl p-6 text-center mb-6 glow-border">
                <code class="text-3xl font-mono font-bold text-accent-cyan tracking-[0.3em]" x-text="deviceFlow.userCode"></code>
              </div>
              <p class="text-gray-500 text-xs text-center mb-2">
                Visit <a :href="deviceFlow.verificationUri" class="text-accent-cyan hover:underline" x-text="deviceFlow.verificationUri" target="_blank"></a>
              </p>
              <a :href="deviceFlow.verificationUri" target="_blank" class="btn-primary w-full block text-center mb-4" @click="navigator.clipboard.writeText(deviceFlow.userCode)">Open GitHub</a>
              <div class="flex items-center justify-center gap-2 text-sm text-gray-500">
                <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
                Waiting for authorization...
              </div>
              <button @click="cancelDeviceFlow()" class="btn-ghost w-full mt-4">Cancel</button>
            </div>
          </div>
        </template>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
          <div class="glass-card p-6 hover-lift animate-in delay-1">
            <div class="flex items-center justify-between mb-4">
              <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Premium Requests</span>
              <div class="w-2 h-2 rounded-full status-pulse" :class="usageData ? (usagePercent > 90 ? 'bg-accent-rose' : usagePercent > 70 ? 'bg-accent-amber' : 'bg-accent-emerald') : 'bg-gray-600'"></div>
            </div>
            <template x-if="usageData">
              <div>
                <div class="flex items-baseline gap-2 mb-3">
                  <span class="text-3xl font-bold text-white font-mono" x-text="usageData.quota_snapshots.premium_interactions.entitlement - usageData.quota_snapshots.premium_interactions.remaining"></span>
                  <span class="text-sm text-gray-500">/ <span x-text="usageData.quota_snapshots.premium_interactions.entitlement"></span></span>
                </div>
                <div class="progress-track">
                  <div class="progress-fill" :class="usagePercent > 90 ? 'bg-accent-rose' : usagePercent > 70 ? 'bg-gradient-to-r from-accent-amber to-accent-rose' : 'bg-gradient-to-r from-accent-cyan to-accent-emerald'" :style="'width:' + usagePercent + '%'"></div>
                </div>
                <p class="text-xs text-gray-500 mt-2">
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
              <p class="text-sm text-gray-500">Unable to load</p>
            </template>
          </div>

          <div class="glass-card p-6 hover-lift animate-in delay-2">
            <div class="flex items-center justify-between mb-4">
              <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Chat Quota</span>
            </div>
            <template x-if="usageData">
              <div>
                <div class="flex items-baseline gap-2 mb-1">
                  <span class="text-2xl font-bold text-white font-mono" x-text="usageData.quota_snapshots.chat.unlimited ? '∞' : usageData.quota_snapshots.chat.remaining"></span>
                  <span class="text-xs text-gray-500" x-show="!usageData.quota_snapshots.chat.unlimited">remaining</span>
                  <span class="text-xs text-accent-emerald" x-show="usageData.quota_snapshots.chat.unlimited">unlimited</span>
                </div>
                <p class="text-xs text-gray-500">Plan: <span class="text-gray-300" x-text="usageData.copilot_plan"></span></p>
              </div>
            </template>
            <template x-if="!usageData">
              <div class="h-8 bg-surface-600 rounded animate-pulse"></div>
            </template>
          </div>

          <div class="glass-card p-6 hover-lift animate-in delay-3">
            <div class="flex items-center justify-between mb-4">
              <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Completions</span>
            </div>
            <template x-if="usageData">
              <div>
                <div class="flex items-baseline gap-2 mb-1">
                  <span class="text-2xl font-bold text-white font-mono" x-text="usageData.quota_snapshots.completions.unlimited ? '∞' : usageData.quota_snapshots.completions.remaining"></span>
                  <span class="text-xs text-gray-500" x-show="!usageData.quota_snapshots.completions.unlimited">remaining</span>
                  <span class="text-xs text-accent-emerald" x-show="usageData.quota_snapshots.completions.unlimited">unlimited</span>
                </div>
                <p class="text-xs text-gray-500">Code completions</p>
              </div>
            </template>
            <template x-if="!usageData">
              <div class="h-8 bg-surface-600 rounded animate-pulse"></div>
            </template>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div class="glass-card p-6 animate-in delay-4">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-xs font-medium text-gray-500 uppercase tracking-widest">GitHub Accounts</h3>
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
              <p class="text-sm text-gray-500">No GitHub accounts connected</p>
            </template>
            <template x-if="meLoaded && githubAccounts.length > 0">
              <div class="space-y-1">
                <template x-for="acct in githubAccounts" :key="acct.id">
                  <div @click="!acct.active && acct.token_valid && switchGithubAccount(acct.id)" class="flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors"
                    :class="!acct.token_valid ? 'bg-accent-rose/5 border border-accent-rose/15' : acct.active ? 'bg-accent-cyan/5 border border-accent-cyan/15' : 'hover:bg-white/[0.03] cursor-pointer border border-transparent'">
                    <div class="flex items-center gap-3">
                      <div class="relative">
                        <img :src="acct.avatar_url" class="w-9 h-9 rounded-lg ring-1 ring-white/5" :class="!acct.token_valid ? 'opacity-50' : ''" />
                        <div x-show="!acct.token_valid" class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-accent-rose ring-2 ring-surface-800"></div>
                        <div x-show="acct.token_valid && acct.active" class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-accent-emerald ring-2 ring-surface-800"></div>
                      </div>
                      <div>
                        <p class="text-sm font-medium" :class="!acct.token_valid ? 'text-gray-400' : 'text-white'" x-text="acct.name || acct.login"></p>
                        <p class="text-xs text-gray-500" x-text="'@' + acct.login"></p>
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      <span x-show="!acct.token_valid" class="text-[10px] font-medium text-accent-rose uppercase tracking-widest">Token Expired</span>
                      <span x-show="acct.token_valid && acct.active" class="text-[10px] font-medium text-accent-emerald uppercase tracking-widest">Active</span>
                      <button @click.stop="disconnectGithub(acct.id, acct.login)" class="text-gray-600 hover:text-accent-rose transition-colors p-1" title="Disconnect">
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
            <h3 class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-4">API Endpoints</h3>
            <div class="space-y-3 font-mono text-xs">
              <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 rounded bg-accent-emerald/10 text-accent-emerald text-[10px] font-bold">POST</span>
                <span class="text-gray-300">/v1/chat/completions</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 rounded bg-accent-emerald/10 text-accent-emerald text-[10px] font-bold">POST</span>
                <span class="text-gray-300">/v1/messages</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 rounded bg-accent-emerald/10 text-accent-emerald text-[10px] font-bold">POST</span>
                <span class="text-gray-300">/v1/responses</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan text-[10px] font-bold">GET</span>
                <span class="text-gray-300">/v1/models</span>
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
        <div class="flex items-center justify-between mb-6">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">API Keys</span>
          <div x-show="isAdmin || isUser" class="flex items-center gap-2">
            <input type="text" x-model="newKeyName" placeholder="Name" class="!text-xs !py-1.5 !px-3 !w-32 !rounded-lg" @keydown.enter="createNewKey()" />
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
            <p class="text-sm text-gray-500 py-4 text-center">No API keys yet. Create one above.</p>
          </template>
          <template x-if="keysLoading && keys.length === 0">
            <div class="space-y-3 py-2">
              <div class="h-10 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-10 bg-surface-600 rounded animate-pulse"></div>
            </div>
          </template>
          <template x-if="keys.length > 0">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-white/5">
                  <th class="text-left py-2 pr-4 pl-7 text-xs font-medium text-gray-500 uppercase tracking-widest">Name</th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Key</th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Created</th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Last Used</th>
                  <th x-show="isAdmin || isUser" class="text-right py-2 pr-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Actions</th>
                </tr>
              </thead>
              <tbody>
                <template x-for="k in keys" :key="k.id">
                  <tr @click="selectedKeyId = k.id" class="border-b border-white/[0.03] transition-colors cursor-pointer"
                    :class="selectedKeyId === k.id ? 'bg-accent-cyan/5 hover:bg-accent-cyan/8' : 'hover:bg-white/[0.02]'">
                    <td class="py-3 pr-4 pl-2">
                      <div class="flex items-center gap-2">
                        <div class="w-1.5 h-1.5 rounded-full shrink-0 transition-colors" :class="selectedKeyId === k.id ? 'bg-accent-cyan' : 'bg-transparent'"></div>
                        <span class="text-white font-medium" x-text="k.name"></span>
                      </div>
                    </td>
                    <td class="py-3 pr-4">
                      <code class="text-xs font-mono text-gray-500 bg-surface-800 rounded px-2 py-1" x-text="truncateKey(k.key)"></code>
                    </td>
                    <td class="py-3 pr-4">
                      <span class="text-gray-500 text-xs cursor-default" :title="fullDateTime(k.created_at)" x-text="timeAgo(k.created_at)"></span>
                    </td>
                    <td class="py-3 pr-4">
                      <span x-show="k.last_used_at" class="text-gray-500 text-xs cursor-default" :title="fullDateTime(k.last_used_at)" x-text="timeAgo(k.last_used_at)"></span>
                      <span x-show="!k.last_used_at" class="text-gray-600 text-xs">Never</span>
                    </td>
                    <td class="py-3 pr-2 text-right">
                      <div class="flex items-center justify-end gap-1">
                        <button @click.stop="copySnippet(k.key, 'key-' + k.id)" class="text-gray-600 hover:text-accent-cyan transition-colors p-1" title="Copy key">
                          <svg x-show="copied !== 'key-' + k.id" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                          <svg x-show="copied === 'key-' + k.id" class="w-4 h-4 text-accent-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </button>
                        <template x-if="isAdmin">
                          <button @click.stop="deleteKeyById(k.id, k.name)" class="text-gray-600 hover:text-accent-rose transition-colors p-1" :disabled="keyDeleting === k.id" title="Delete key">
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

      <div class="glass-card p-6 animate-in delay-1">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Configuration</span>
        <template x-if="selectedKeyId">
          <p class="text-xs text-accent-cyan mt-2 flex items-center gap-1.5">
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
                :class="configTab === 'claude' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">Claude Code</button>
              <button @click="configTab='codex'" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="configTab === 'codex' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">Codex</button>
              <button @click="configTab='gemini'" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="configTab === 'gemini' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">Gemini CLI</button>
            </div>

            <!-- Claude Code -->
            <div x-show="configTab === 'claude'" x-transition>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div class="flex items-center gap-2">
                  <label class="text-xs text-gray-500">Model:</label>
                  <select x-model="claudeModel" class="text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer">
                    <template x-for="m in claudeModelsBig" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
              </div>
              <p class="text-[11px] text-gray-600 mb-2">Add to <code class="text-gray-500">~/.bashrc</code> or <code class="text-gray-500">~/.zshrc</code></p>
              ${codeBlock("bash", "claudeCode", "claudeCodeSnippet", "claude")}
            </div>

            <!-- Codex -->
            <div x-show="configTab === 'codex'" x-transition>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div class="flex items-center gap-2">
                  <label class="text-xs text-gray-500">Model:</label>
                  <select x-model="codexModel" class="text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer">
                    <template x-for="m in codexModels" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
              </div>
              <p class="text-[11px] text-gray-600 mb-2">1. Add to <code class="text-gray-500">~/.codex/config.toml</code></p>
              ${codeBlock("toml", "codexToml", "codexSnippet", "codex-toml")}
              <p class="text-[11px] text-gray-600 mb-2 mt-4">2. Add to <code class="text-gray-500">~/.bashrc</code> or <code class="text-gray-500">~/.zshrc</code></p>
              ${codeBlock("bash", "codexEnv", "codexEnvSnippet", "codex-env")}
              <p class="text-[11px] text-gray-600 mb-2 mt-4">3. Start Codex</p>
              ${codeBlock("bash", "codexStart", "codexStartSnippet", "codex-start")}
            </div>

            <!-- Gemini CLI -->
            <div x-show="configTab === 'gemini'" x-transition>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div class="flex items-center gap-2">
                  <label class="text-xs text-gray-500">Model:</label>
                  <select x-model="geminiModel" class="text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer">
                    <template x-for="m in geminiModels" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
              </div>
              <p class="text-[11px] text-gray-600 mb-2">Add to <code class="text-gray-500">~/.bashrc</code> or <code class="text-gray-500">~/.zshrc</code></p>
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
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div class="flex items-center gap-3">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Token Usage</span>
            <template x-if="tokenLoading">
              <svg class="animate-spin h-3.5 w-3.5 text-gray-500" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
              </svg>
            </template>
          </div>
          <div class="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
            <button @click="switchTokenRange('today')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === 'today' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">Today</button>
            <button @click="switchTokenRange('7d')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === '7d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">7 Days</button>
            <button @click="switchTokenRange('30d')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === '30d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">30 Days</button>
          </div>
        </div>

        <div style="height: 320px; position: relative;">
          <template x-if="tokenLoading && !tokenChart">
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="flex flex-col items-center gap-3">
                <svg class="animate-spin h-6 w-6 text-accent-cyan/60" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
                <span class="text-xs text-gray-500">Loading usage data…</span>
              </div>
            </div>
          </template>
          <canvas id="tokenChart"></canvas>
        </div>

        <div class="grid grid-cols-3 gap-4 mt-6 pt-5 border-t border-white/5">
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Requests</p>
            <p class="text-lg font-bold font-mono text-white" x-text="tokenSummary.requests.toLocaleString()"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Input Tokens</p>
            <p class="text-lg font-bold font-mono text-white" x-text="tokenSummary.input.toLocaleString()"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Output Tokens</p>
            <p class="text-lg font-bold font-mono text-white" x-text="tokenSummary.output.toLocaleString()"></p>
          </div>
        </div>
      </div>

      <div class="glass-card p-6 mt-5 animate-in delay-1" x-show="tokenByModel.length > 0">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-4 block">By Model</span>

        <!-- Stacked horizontal bars -->
        <div class="space-y-4 mb-6" @mouseleave="hoveredModel = null">
          <div>
            <p class="text-[11px] text-gray-500 mb-1.5">Requests</p>
            <div class="flex h-6 rounded-lg overflow-hidden bg-surface-800">
              <template x-for="(m, i) in tokenByModel" :key="'req-'+m.model">
                <div class="h-full transition-all duration-150 relative cursor-pointer"
                  @mouseenter="hoveredModel = m.model"
                  :style="'width:' + modelPercent('requests')[i] + '%;background:' + modelColors[i % modelColors.length] + ';opacity:' + (hoveredModel && hoveredModel !== m.model ? '0.25' : '1')"
                  x-show="modelPercent('requests')[i] > 0">
                  <span class="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-white/90 pointer-events-none"
                    x-show="modelPercent('requests')[i] > 8"
                    x-text="modelPercent('requests')[i] + '%'"></span>
                </div>
              </template>
            </div>
          </div>
          <div>
            <p class="text-[11px] text-gray-500 mb-1.5">Input Tokens</p>
            <div class="flex h-6 rounded-lg overflow-hidden bg-surface-800">
              <template x-for="(m, i) in tokenByModel" :key="'in-'+m.model">
                <div class="h-full transition-all duration-150 relative cursor-pointer"
                  @mouseenter="hoveredModel = m.model"
                  :style="'width:' + modelPercent('input')[i] + '%;background:' + modelColors[i % modelColors.length] + ';opacity:' + (hoveredModel && hoveredModel !== m.model ? '0.25' : '1')"
                  x-show="modelPercent('input')[i] > 0">
                  <span class="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-white/90 pointer-events-none"
                    x-show="modelPercent('input')[i] > 8"
                    x-text="modelPercent('input')[i] + '%'"></span>
                </div>
              </template>
            </div>
          </div>
          <div>
            <p class="text-[11px] text-gray-500 mb-1.5">Output Tokens</p>
            <div class="flex h-6 rounded-lg overflow-hidden bg-surface-800">
              <template x-for="(m, i) in tokenByModel" :key="'out-'+m.model">
                <div class="h-full transition-all duration-150 relative cursor-pointer"
                  @mouseenter="hoveredModel = m.model"
                  :style="'width:' + modelPercent('output')[i] + '%;background:' + modelColors[i % modelColors.length] + ';opacity:' + (hoveredModel && hoveredModel !== m.model ? '0.25' : '1')"
                  x-show="modelPercent('output')[i] > 0">
                  <span class="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-white/90 pointer-events-none"
                    x-show="modelPercent('output')[i] > 8"
                    x-text="modelPercent('output')[i] + '%'"></span>
                </div>
              </template>
            </div>
          </div>
          <!-- Hover detail -->
          <div class="h-5 flex items-center">
            <template x-if="hoveredModel">
              <p class="text-xs text-gray-300 font-mono" x-text="(() => { const m = tokenByModel.find(x => x.model === hoveredModel); return m ? hoveredModel + '  \u2014  ' + m.requests.toLocaleString() + ' reqs \u00b7 ' + m.input.toLocaleString() + ' in \u00b7 ' + m.output.toLocaleString() + ' out' : ''; })()"></p>
            </template>
          </div>
          <!-- Legend -->
          <div class="flex flex-wrap gap-x-4 gap-y-1.5">
            <template x-for="(m, i) in tokenByModel" :key="'leg-'+m.model">
              <div class="flex items-center gap-1.5 cursor-pointer transition-opacity duration-150"
                @mouseenter="hoveredModel = m.model" @mouseleave="hoveredModel = null"
                :style="'opacity:' + (hoveredModel && hoveredModel !== m.model ? '0.35' : '1')">
                <span class="w-2.5 h-2.5 rounded-sm shrink-0" :style="'background:' + modelColors[i % modelColors.length]"></span>
                <span class="text-[11px] text-gray-400 font-mono" x-text="m.model"></span>
              </div>
            </template>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-white/5">
                <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Model</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Requests</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Input Tokens</th>
                <th class="text-right py-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Output Tokens</th>
              </tr>
            </thead>
            <tbody>
              <template x-for="(m, i) in tokenByModel" :key="m.model">
                <tr class="border-b border-white/[0.03] transition-all duration-150 cursor-pointer"
                  @mouseenter="hoveredModel = m.model" @mouseleave="hoveredModel = null"
                  :class="hoveredModel === m.model ? 'bg-white/[0.04]' : (hoveredModel ? 'opacity-40' : '')">
                  <td class="py-2.5 pr-4">
                    <span class="inline-flex items-center gap-2">
                      <span class="w-2 h-2 rounded-sm shrink-0" :style="'background:' + modelColors[i % modelColors.length]"></span>
                      <code class="text-xs font-mono text-accent-cyan" x-text="m.model"></code>
                    </span>
                  </td>
                  <td class="py-2.5 pr-4 text-right text-gray-300 font-mono text-xs" x-text="m.requests.toLocaleString()"></td>
                  <td class="py-2.5 pr-4 text-right text-gray-300 font-mono text-xs" x-text="m.input.toLocaleString()"></td>
                  <td class="py-2.5 text-right text-gray-300 font-mono text-xs" x-text="m.output.toLocaleString()"></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `
}

export function renderLatencyTab(): string {
  return `
    <div x-show="tab === 'latency'">
      <div class="glass-card p-6 animate-in">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div class="flex items-center gap-3">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Latency</span>
            <template x-if="latencyLoading">
              <svg class="animate-spin h-3.5 w-3.5 text-gray-500" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
              </svg>
            </template>
          </div>
          <div class="flex items-center gap-3">
            <div class="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
              <button @click="switchLatencyRange('today')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="latencyRange === 'today' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">Today</button>
              <button @click="switchLatencyRange('7d')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="latencyRange === '7d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">7 Days</button>
              <button @click="switchLatencyRange('30d')" class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="latencyRange === '30d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">30 Days</button>
            </div>
            <template x-if="latencyModels.length > 0">
              <select @change="switchLatencyModel($event.target.value)" x-model="latencyModel"
                class="text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer">
                <option value="">All Models</option>
                <template x-for="m in latencyModels" :key="m">
                  <option :value="m" x-text="m"></option>
                </template>
              </select>
            </template>
          </div>
        </div>

        <div style="height: 320px; position: relative;">
          <template x-if="latencyLoading && !latencyChart">
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="flex flex-col items-center gap-3">
                <svg class="animate-spin h-6 w-6 text-accent-cyan/60" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                </svg>
                <span class="text-xs text-gray-500">Loading latency data\u2026</span>
              </div>
            </div>
          </template>
          <canvas id="latencyChart"></canvas>
        </div>

        <div class="grid grid-cols-4 gap-4 mt-6 pt-5 border-t border-white/5">
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Avg Total</p>
            <p class="text-lg font-bold font-mono text-white" x-text="latencySummary.avgTotal + ' ms'"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Avg Upstream</p>
            <p class="text-lg font-bold font-mono text-white" x-text="latencySummary.avgUpstream + ' ms'"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Avg TTFB</p>
            <p class="text-lg font-bold font-mono text-white" x-text="latencySummary.avgTtfb + ' ms'"></p>
          </div>
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Token Miss Rate</p>
            <p class="text-lg font-bold font-mono" :class="latencySummary.tokenMissRate > 50 ? 'text-accent-rose' : latencySummary.tokenMissRate > 20 ? 'text-accent-amber' : 'text-accent-emerald'" x-text="latencySummary.tokenMissRate + '%'"></p>
          </div>
        </div>
      </div>

      <div class="glass-card p-6 mt-5 animate-in delay-1" x-show="latencyByType.length > 0">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-4 block">By Type</span>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-white/5">
                <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Type</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Requests</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Avg Total</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Avg Upstream</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Avg TTFB</th>
                <th class="text-right py-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Token Miss</th>
              </tr>
            </thead>
            <tbody>
              <template x-for="t in latencyByType" :key="t.type">
                <tr class="border-b border-white/[0.03]">
                  <td class="py-2.5 pr-4"><code class="text-xs font-mono" :class="t.type === 'Stream' ? 'text-accent-cyan' : 'text-accent-amber'" x-text="t.type"></code></td>
                  <td class="py-2.5 pr-4 text-right text-gray-300 font-mono text-xs" x-text="t.requests.toLocaleString()"></td>
                  <td class="py-2.5 pr-4 text-right text-gray-300 font-mono text-xs" x-text="t.avgTotal + ' ms'"></td>
                  <td class="py-2.5 pr-4 text-right text-gray-300 font-mono text-xs" x-text="t.avgUpstream + ' ms'"></td>
                  <td class="py-2.5 pr-4 text-right text-gray-300 font-mono text-xs" x-text="t.avgTtfb + ' ms'"></td>
                  <td class="py-2.5 text-right font-mono text-xs" :class="t.tokenMissRate > 50 ? 'text-accent-rose' : t.tokenMissRate > 20 ? 'text-accent-amber' : 'text-accent-emerald'" x-text="t.tokenMissRate + '%'"></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>

      <div class="glass-card p-6 mt-5 animate-in delay-1" x-show="latencyByColo.length > 0">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-4 block">By Data Center</span>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-white/5">
                <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Colo</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Requests</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Avg Total</th>
                <th class="text-right py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Avg Upstream</th>
                <th class="text-right py-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Token Miss</th>
              </tr>
            </thead>
            <tbody>
              <template x-for="c in latencyByColo" :key="c.colo">
                <tr class="border-b border-white/[0.03]">
                  <td class="py-2.5 pr-4"><code class="text-xs font-mono text-accent-cyan" x-text="c.colo"></code></td>
                  <td class="py-2.5 pr-4 text-right text-gray-300 font-mono text-xs" x-text="c.requests.toLocaleString()"></td>
                  <td class="py-2.5 pr-4 text-right text-gray-300 font-mono text-xs" x-text="c.avgTotal + ' ms'"></td>
                  <td class="py-2.5 pr-4 text-right text-gray-300 font-mono text-xs" x-text="c.avgUpstream + ' ms'"></td>
                  <td class="py-2.5 text-right font-mono text-xs" :class="c.tokenMissRate > 50 ? 'text-accent-rose' : c.tokenMissRate > 20 ? 'text-accent-amber' : 'text-accent-emerald'" x-text="c.tokenMissRate + '%'"></td>
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
          <h3 class="text-white font-semibold mb-1">Export Data</h3>
          <p class="text-sm text-gray-400 mb-4">Download all API keys, GitHub accounts, and usage data as a JSON file.</p>
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
