import { useAuth } from "../state/auth"
import { UserMenu } from "./UserMenu"

interface Props {
  tabs: ReadonlyArray<{ id: string; label: string }>
  currentTab: string
  onTabChange: (id: string) => void
}

export function Layout({ tabs, currentTab, onTabChange, children }: Props & { children: React.ReactNode }) {
  const { session } = useAuth()

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header
        className="border-b border-white/5 sticky top-0 z-50 backdrop-blur-md"
        style={{ background: "color-mix(in srgb, var(--surface-900) 80%, transparent)", borderColor: "var(--border-color)" }}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-surface-700 glow-border flex items-center justify-center">
              <svg className="w-4 h-4 text-accent-violet" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <span className="font-semibold text-sm tracking-tight text-themed">Copilot Gateway</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => (window as unknown as { toggleLang?: () => void }).toggleLang?.()}
              className="theme-toggle w-8 h-8"
              title="切换语言 / Toggle language"
            >
              <span className="text-xs font-semibold">
                {(typeof window !== "undefined" &&
                  (window as unknown as { __lang?: string }).__lang === "zh")
                  ? "EN"
                  : "中"}
              </span>
            </button>
            <button
              onClick={() => (window as unknown as { toggleTheme?: () => void }).toggleTheme?.()}
              className="theme-toggle"
              title="Toggle theme"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="5" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
              </svg>
            </button>
            <div className="text-xs text-themed-dim hidden sm:block">
              {session?.userName || session?.email || (session?.isAdmin ? "Admin" : "")}
            </div>
            <UserMenu onNavigate={onTabChange} canNavigateSettings={true} />
          </div>
        </div>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-3">
          <nav className="flex gap-1 bg-surface-800 rounded-lg p-0.5 overflow-x-auto scrollbar-hide">
            {tabs.map((t) => {
              const active = t.id === currentTab
              return (
                <button
                  key={t.id}
                  onClick={() => onTabChange(t.id)}
                  className={`px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-xs sm:text-sm font-medium transition-all whitespace-nowrap ${
                    active ? "bg-surface-600 text-themed" : "text-themed-dim hover:text-themed-secondary"
                  }`}
                >
                  {t.label}
                </button>
              )
            })}
          </nav>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 w-full flex-1 min-h-0 flex flex-col overflow-y-auto">{children}</main>
    </div>
  )
}
