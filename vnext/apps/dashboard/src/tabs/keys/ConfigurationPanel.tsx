import { useEffect, useRef, useState } from "react"
import type { ApiKeyDetail } from "../../api/keys"
import { useT } from "../../state/i18n"
import { useModelCatalog } from "../../state/models"
import { useToast } from "../../state/toast"
import { Select } from "../../components/Select"
import {
  claudeCodeSettingsSnippet,
  claudeCodeShellSnippet,
  codexEnvSnippet,
  codexStartSnippet,
  codexTomlSnippet,
  geminiSnippet,
} from "./configSnippets"

interface Props {
  keyRow: ApiKeyDetail
}

type ConfigTab = "claude" | "codex" | "gemini"
type ClaudeFormat = "shell" | "settings"

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

interface CodeBlockProps {
  language: string
  text: string
  onCopy: () => void | Promise<void>
  copied: boolean
}
function CodeBlock({ language, text, onCopy, copied }: CodeBlockProps) {
  const t = useT()
  return (
    <div className="relative group">
      <pre className="code-block rounded-xl p-4 pr-10 overflow-x-auto whitespace-pre">
        <code className={`language-${language}`}>{text}</code>
      </pre>
      <button
        type="button"
        onClick={() => void onCopy()}
        className="code-block-btn absolute top-2.5 right-2.5 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
        title={copied ? t("dash.codeCopyTipCopied") : t("dash.codeCopyTipCopy")}
      >
        {copied ? (
          <svg className="w-3.5 h-3.5 text-accent-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </div>
  )
}

export function ConfigurationPanel({ keyRow }: Props) {
  const { push: toast } = useToast()
  const { catalog, loading } = useModelCatalog()
  const t = useT()
  const [tab, setTab] = useState<ConfigTab>("claude")
  const [claudeBig, setClaudeBig] = useState<string>("")
  const [claudeSmall, setClaudeSmall] = useState<string>("")
  const [claudeFormat, setClaudeFormat] = useState<ClaudeFormat>("shell")
  const [codexModel, setCodexModel] = useState<string>("")
  const [geminiModel, setGeminiModel] = useState<string>("")
  const [copiedTag, setCopiedTag] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Seed selections once the catalog loads / changes.
  useEffect(() => {
    if (catalog.claudeBig.length > 0 && !catalog.claudeBig.includes(claudeBig)) {
      setClaudeBig(catalog.claudeBig[0]!)
    }
  }, [catalog.claudeBig, claudeBig])
  useEffect(() => {
    if (catalog.claudeSmall.length > 0 && !catalog.claudeSmall.includes(claudeSmall)) {
      setClaudeSmall(catalog.claudeSmall[0]!)
    }
  }, [catalog.claudeSmall, claudeSmall])
  useEffect(() => {
    if (catalog.codex.length > 0 && !catalog.codex.includes(codexModel)) {
      setCodexModel(catalog.codex[0]!)
    }
  }, [catalog.codex, codexModel])
  useEffect(() => {
    if (catalog.gemini.length > 0 && !catalog.gemini.includes(geminiModel)) {
      setGeminiModel(catalog.gemini[0]!)
    }
  }, [catalog.gemini, geminiModel])

  // keyRow.key is the plaintext key value returned by GET /api/keys
  // (the server already gates this to the owner/admin/assignee). Fall
  // back to a placeholder if it's somehow missing.
  const keyValue = keyRow.key || "<YOUR_KEY>"
  const baseUrl = typeof window !== "undefined" ? window.location.origin : ""

  const doCopy = async (text: string, tag: string, label?: string) => {
    const ok = await copyToClipboard(text)
    toast(ok ? (label ?? t("dash.copiedToast")) : t("dash.clipboardUnavailable"), ok ? "success" : "error")
    if (ok) {
      setCopiedTag(tag)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopiedTag(null), 2000)
    }
  }

  const otherGroups = catalog.byUpstream.filter(
    (g) => g.provider !== "copilot" && g.models.length > 0,
  )

  const subTabBtn = (id: ConfigTab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
        tab === id ? "bg-surface-600 text-themed" : "text-themed-dim hover:text-themed-secondary"
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="glass-card p-4 sm:p-6 mb-6 animate-in delay-1">
      <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">
        {t("dash.configurationLabel")}
      </span>
      <p className="text-xs text-accent-violet mt-2 flex items-center gap-1.5">
        <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        {t("dash.configUsesSelectedKey")}
      </p>

      {loading ? (
        <p className="mt-4 text-xs text-themed-dim">{t("dash.loadingModels")}</p>
      ) : (
        <div className="mt-4">
          <div className="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5 mb-5 w-fit">
            {subTabBtn("claude", "Claude Code")}
            {subTabBtn("codex", "Codex")}
            {subTabBtn("gemini", "Gemini CLI")}
          </div>

          {tab === "claude" ? (
            <div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <label className="text-xs text-themed-dim whitespace-nowrap">{t("dash.model")}</label>
                  <Select
                    value={claudeBig}
                    onChange={setClaudeBig}
                    className="min-w-[140px]"
                    options={catalog.claudeBig.map((m) => ({ value: m, label: m }))}
                  />
                </div>
                <div className="flex items-center gap-2 min-w-0">
                  <label className="text-xs text-themed-dim whitespace-nowrap">{t("dash.smallFastModel")}</label>
                  <Select
                    value={claudeSmall}
                    onChange={setClaudeSmall}
                    className="min-w-[140px]"
                    options={catalog.claudeSmall.map((m) => ({ value: m, label: m }))}
                  />
                </div>
              </div>
              <div className="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5 mb-3 w-fit">
                <button
                  type="button"
                  onClick={() => setClaudeFormat("shell")}
                  className={`px-3 py-1 rounded-md text-[11px] font-medium transition-all ${
                    claudeFormat === "shell"
                      ? "bg-surface-600 text-themed"
                      : "text-themed-dim hover:text-themed-secondary"
                  }`}
                >
                  {t("dash.shellRc")}
                </button>
                <button
                  type="button"
                  onClick={() => setClaudeFormat("settings")}
                  className={`px-3 py-1 rounded-md text-[11px] font-medium transition-all ${
                    claudeFormat === "settings"
                      ? "bg-surface-600 text-themed"
                      : "text-themed-dim hover:text-themed-secondary"
                  }`}
                >
                  {t("dash.settingsJson")}
                </button>
              </div>
              {claudeFormat === "shell" ? (
                <>
                  <p className="text-[11px] text-themed-dim mb-2">
                    {t("dash.addToBashrc")}
                  </p>
                  {(() => {
                    const txt = claudeCodeShellSnippet(claudeBig, claudeSmall, baseUrl, keyValue)
                    return (
                      <CodeBlock
                        language="bash"
                        text={txt}
                        copied={copiedTag === "claude-shell"}
                        onCopy={() => doCopy(txt, "claude-shell")}
                      />
                    )
                  })()}
                </>
              ) : (
                <>
                  <p className="text-[11px] text-themed-dim mb-2">
                    {t("dash.mergeIntoSettings")}
                  </p>
                  {(() => {
                    const txt = claudeCodeSettingsSnippet(claudeBig, claudeSmall, baseUrl, keyValue)
                    return (
                      <CodeBlock
                        language="json"
                        text={txt}
                        copied={copiedTag === "claude-settings"}
                        onCopy={() => doCopy(txt, "claude-settings")}
                      />
                    )
                  })()}
                </>
              )}
            </div>
          ) : null}

          {tab === "codex" ? (
            <div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <label className="text-xs text-themed-dim whitespace-nowrap">{t("dash.model")}</label>
                  <Select
                    value={codexModel}
                    onChange={setCodexModel}
                    className="min-w-[140px]"
                    options={catalog.codex.map((m) => ({ value: m, label: m }))}
                  />
                </div>
              </div>
              <p className="text-[11px] text-themed-dim mb-2">
                {t("dash.addCodexConfig")}
              </p>
              {(() => {
                const txt = codexTomlSnippet(codexModel, baseUrl)
                return (
                  <CodeBlock
                    language="toml"
                    text={txt}
                    copied={copiedTag === "codex-toml"}
                    onCopy={() => doCopy(txt, "codex-toml")}
                  />
                )
              })()}
              <p className="text-[11px] text-themed-dim mb-2 mt-4">
                2. {t("dash.addToBashrc")}
              </p>
              {(() => {
                const txt = codexEnvSnippet(keyValue)
                return (
                  <CodeBlock
                    language="bash"
                    text={txt}
                    copied={copiedTag === "codex-env"}
                    onCopy={() => doCopy(txt, "codex-env")}
                  />
                )
              })()}
              <p className="text-[11px] text-themed-dim mb-2 mt-4">{t("dash.startCodex")}</p>
              {(() => {
                const txt = codexStartSnippet(codexModel)
                return (
                  <CodeBlock
                    language="bash"
                    text={txt}
                    copied={copiedTag === "codex-start"}
                    onCopy={() => doCopy(txt, "codex-start")}
                  />
                )
              })()}
            </div>
          ) : null}

          {tab === "gemini" ? (
            <div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <label className="text-xs text-themed-dim whitespace-nowrap">{t("dash.model")}</label>
                  <Select
                    value={geminiModel}
                    onChange={setGeminiModel}
                    className="min-w-[140px]"
                    options={catalog.gemini.map((m) => ({ value: m, label: m }))}
                  />
                </div>
              </div>
              <p className="text-[11px] text-themed-dim mb-2">
                {t("dash.addToBashrc")}
              </p>
              {(() => {
                const txt = geminiSnippet(geminiModel, baseUrl, keyValue)
                return (
                  <CodeBlock
                    language="bash"
                    text={txt}
                    copied={copiedTag === "gemini-env"}
                    onCopy={() => doCopy(txt, "gemini-env")}
                  />
                )
              })()}
            </div>
          ) : null}

          {otherGroups.length > 0 ? (
            <div className="mt-6 pt-6 border-t border-white/10">
              <h4 className="text-xs font-medium text-themed-dim uppercase tracking-widest mb-2">
                {t("dash.otherAvailableModels")}
              </h4>
              <p className="text-[11px] text-themed-dim mb-3">
                {t("dash.otherModelsDesc", { form: "upstreamId/model" })}
              </p>
              {otherGroups.map((grp) => (
                <div key={grp.upstream} className="mb-3">
                  <div className="text-[11px] text-themed-dim mb-1">
                    <span className="font-mono">{grp.upstream}</span>
                    <span
                      className={`ml-1 px-1.5 py-0.5 rounded text-[10px] ${
                        grp.provider === "azure"
                          ? "bg-blue-900/40 text-blue-300"
                          : "bg-purple-900/40 text-purple-300"
                      }`}
                    >
                      {grp.provider}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {grp.models.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={(e) => {
                          const txt = e.shiftKey ? `${grp.upstream}/${m.id}` : m.id
                          doCopy(txt, `model-${grp.upstream}-${m.id}`, t("dash.copiedModelId"))
                        }}
                        title={`click: copy ${m.id}\nshift-click: copy pinned ${grp.upstream}/${m.id}`}
                        className="px-2 py-0.5 bg-surface-600 hover:bg-surface-500 rounded text-themed font-mono text-xs"
                      >
                        {m.id}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
