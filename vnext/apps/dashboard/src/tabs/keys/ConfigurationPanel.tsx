import { SetupPanel } from "./SetupPanel"
import { canSetup } from "./setup-state"
import { copyToClipboard } from "./helpers"
import { useEffect, useId, useRef, useState } from "react"
import type { ApiKeyDetail } from "../../api/keys"
import { useT } from "../../state/i18n"
import type { ModelCatalog } from "../../state/models"
import { useToast } from "../../state/toast"
import { useAuth } from "../../state/auth"
import { Info } from "lucide-react"
import { Badge } from "../../ui/badge"
import { Card, SectionHeading } from "../../ui/card"
import { CodeBlock } from "../../ui/code-block"
import { SegmentedControl } from "../../ui/segmented-control"
import { Select } from "../../ui/select"
import {
  availableClaudeTierSelection,
  claudeCodeSettingsSnippet,
  claudeCodeShellSnippet,
  codexEnvSnippet,
  codexStartSnippet,
  codexTomlSnippet,
  geminiSnippet,
} from "./configSnippets"
import type { ClaudeTierSelections } from "./configSnippets"
import { CodexCapabilityRequestGate, hasConfirmedCodexWebSocketCapability, readCodexWebSocketCapability } from "./codex-capability"

interface Props {
  keyRow: ApiKeyDetail
  catalog: ModelCatalog
  catalogLoading: boolean
}

type ConfigTab = "claude" | "codex" | "gemini"
type ClaudeFormat = "shell" | "settings"

export function ConfigurationPanel({ keyRow, catalog, catalogLoading }: Props) {
  const { push: toast } = useToast()
  const { session } = useAuth()
  const t = useT()
  const panelId = useId()
  const [tab, setTab] = useState<ConfigTab>("claude")
  const [claudeBig, setClaudeBig] = useState<string>("")
  const [claudeSmall, setClaudeSmall] = useState<string>("")
  const [claudeTiers, setClaudeTiers] = useState<ClaudeTierSelections>({})
  const [claudeFormat, setClaudeFormat] = useState<ClaudeFormat>("shell")
  const [claudeDisableArtifact, setClaudeDisableArtifact] = useState(false)
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
  const selectedClaudeTiers: ClaudeTierSelections = {
    opus: availableClaudeTierSelection(claudeTiers.opus ?? "", catalog.claudeBig),
    sonnet: availableClaudeTierSelection(claudeTiers.sonnet ?? "", catalog.claudeBig),
    haiku: availableClaudeTierSelection(claudeTiers.haiku ?? "", catalog.claudeBig),
  }
  useEffect(() => {
    setClaudeTiers((previous) => {
      const next: ClaudeTierSelections = {
        opus: availableClaudeTierSelection(previous.opus ?? "", catalog.claudeBig),
        sonnet: availableClaudeTierSelection(previous.sonnet ?? "", catalog.claudeBig),
        haiku: availableClaudeTierSelection(previous.haiku ?? "", catalog.claudeBig),
      }
      return next.opus === (previous.opus ?? "") &&
        next.sonnet === (previous.sonnet ?? "") &&
        next.haiku === (previous.haiku ?? "") ? previous : next
    })
  }, [catalog.claudeBig])
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
  const hasSession = session !== null
  const capabilityScope = JSON.stringify([baseUrl, hasSession, session?.userId, session?.sessionToken, keyRow.id])
  const capabilityGate = useRef(new CodexCapabilityRequestGate())
  const [codexCapability, setCodexCapability] = useState({ scope: "", available: false })
  useEffect(() => {
    const gate = capabilityGate.current
    gate.invalidate()
    setCodexCapability({ scope: capabilityScope, available: false })
    if (!baseUrl || !hasSession) return
    const { ticket, signal } = gate.begin(capabilityScope)
    void readCodexWebSocketCapability(baseUrl, signal).then(available => {
      if (gate.accepts(ticket, capabilityScope)) {
        setCodexCapability({ scope: capabilityScope, available })
      }
    })
    return () => gate.invalidate()
  }, [baseUrl, capabilityScope, hasSession])
  const codexWebSocketsAvailable = hasConfirmedCodexWebSocketCapability(codexCapability, capabilityScope)

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

  const codeBlock = (language: string, tag: string, txt: string) => {
    const copied = copiedTag === tag
    return (
      <CodeBlock
        language={language}
        text={txt}
        copied={copied}
        copyLabel={copied ? t("dash.codeCopyTipCopied") : t("dash.codeCopyTipCopy")}
        onCopy={() => doCopy(txt, tag)}
      />
    )
  }

  // A visible label and the select it names; the select is wrapped because ui/select fills its container.
  const modelPicker = (id: string, label: string, value: string, onChange: (value: string) => void, options: Array<{ value: string; label: string }>) => (
    <div key={id} className="flex min-w-0 items-center gap-2">
      <label id={id} htmlFor={`${id}-select`} className="whitespace-nowrap text-xs font-medium text-fg-muted">{label}</label>
      <div className="min-w-[220px]">
        <Select id={`${id}-select`} value={value} onChange={onChange} labelledBy={id} options={options} />
      </div>
    </div>
  )

  const hint = "mb-2 text-xs text-fg-subtle"

  return (
    <Card aria-labelledby={`${panelId}-title`}>
      <SectionHeading id={`${panelId}-title`}>{t("dash.configurationLabel")}</SectionHeading>
      <p className="mt-2 flex items-center gap-1.5 text-body text-fg-muted">
        <Info className="size-3.5 shrink-0" aria-hidden="true" />
        {t("dash.configUsesSelectedKey")}
      </p>

      {catalogLoading ? (
        <p className="mt-4 text-xs text-fg-subtle">{t("dash.loadingModels")}</p>
      ) : (
        <div className="mt-4">
          <SegmentedControl
            className="mb-5"
            options={[
              { value: "claude", label: "Claude Code" },
              { value: "codex", label: "Codex" },
              { value: "gemini", label: "Gemini CLI" },
            ]}
            value={tab}
            onChange={setTab}
            ariaLabel={t("dash.configClientAria")}
          />

          {tab === "claude" ? (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                {modelPicker(`${panelId}-claude-model`, t("dash.model"), claudeBig, setClaudeBig, catalog.claudeBig.map((m) => ({ value: m, label: m })))}
                {modelPicker(`${panelId}-claude-small`, t("dash.smallFastModel"), claudeSmall, setClaudeSmall, catalog.claudeSmall.map((m) => ({ value: m, label: m })))}
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                {([
                  { tier: "opus", label: t("dash.claudeDefaultOpusModel") },
                  { tier: "sonnet", label: t("dash.claudeDefaultSonnetModel") },
                  { tier: "haiku", label: t("dash.claudeDefaultHaikuModel") },
                ] as const).map(({ tier, label }) =>
                  modelPicker(
                    `${panelId}-claude-${tier}`,
                    label,
                    selectedClaudeTiers[tier] ?? "",
                    (value) => setClaudeTiers((previous) => ({ ...previous, [tier]: value })),
                    [
                      { value: "", label: t("dash.claudeDefaultUnselected") },
                      ...catalog.claudeBig.map((model) => ({ value: model, label: model })),
                    ],
                  ),
                )}
              </div>
              <label className="mb-3 flex w-fit items-center gap-2 text-xs text-fg-muted">
                <input type="checkbox" className="accent-brand" checked={claudeDisableArtifact} onChange={(event) => setClaudeDisableArtifact(event.target.checked)} />
                {t("dash.claudeDisableArtifact")}
              </label>
              <SegmentedControl
                size="sm"
                className="mb-3"
                options={[
                  { value: "shell", label: t("dash.shellRc") },
                  { value: "settings", label: t("dash.settingsJson") },
                ]}
                value={claudeFormat}
                onChange={setClaudeFormat}
                ariaLabel={t("dash.configFormatAria")}
              />
              {claudeFormat === "shell" ? (
                <>
                  <p className={hint}>{t("dash.addToBashrc")}</p>
                  {codeBlock("bash", "claude-shell", claudeCodeShellSnippet(claudeBig, claudeSmall, baseUrl, keyValue, catalog.mappedModelIds, selectedClaudeTiers))}
                </>
              ) : (
                <>
                  <p className={hint}>{t("dash.mergeIntoSettings")}</p>
                  {codeBlock("json", "claude-settings", claudeCodeSettingsSnippet(claudeBig, claudeSmall, baseUrl, keyValue, catalog.mappedModelIds, selectedClaudeTiers, { disableArtifact: claudeDisableArtifact }))}
                </>
              )}
            </div>
          ) : null}

          {tab === "codex" ? (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                {modelPicker(`${panelId}-codex-model`, t("dash.model"), codexModel, setCodexModel, catalog.codex.map((m) => ({ value: m, label: m })))}
              </div>
              <p className={hint}>{t("dash.addCodexConfig")}</p>
              {codeBlock("toml", "codex-toml", codexTomlSnippet(codexModel, baseUrl, codexWebSocketsAvailable))}
              <p className={`${hint} mt-4`}>2. {t("dash.addToBashrc")}</p>
              {codeBlock("bash", "codex-env", codexEnvSnippet(keyValue))}
              <p className={`${hint} mt-4`}>{t("dash.startCodex")}</p>
              {codeBlock("bash", "codex-start", codexStartSnippet(codexModel))}
            </div>
          ) : null}

          {tab === "gemini" ? (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                {modelPicker(`${panelId}-gemini-model`, t("dash.model"), geminiModel, setGeminiModel, catalog.gemini.map((m) => ({ value: m, label: m })))}
              </div>
              <p className={hint}>{t("dash.addToBashrc")}</p>
              {codeBlock("bash", "gemini-env", geminiSnippet(geminiModel, baseUrl, keyValue))}
            </div>
          ) : null}

          {tab !== "gemini" && canSetup(keyRow, session) && baseUrl ? (
            <SetupPanel key={`${keyRow.id}:${session?.userId}:${tab}`} keyId={keyRow.id} client={tab} origin={baseUrl}
              settings={tab === "codex" ? { model: codexModel || null } : {
                model: claudeBig || null, smallModel: claudeSmall || null,
                opusModel: selectedClaudeTiers.opus || null, sonnetModel: selectedClaudeTiers.sonnet || null, haikuModel: selectedClaudeTiers.haiku || null,
                disableArtifact: claudeDisableArtifact,
              }} />
          ) : null}

          {otherGroups.length > 0 ? (
            <div className="mt-6 border-t border-border pt-6">
              <SectionHeading as="h3" className="mb-2">{t("dash.otherAvailableModels")}</SectionHeading>
              <p className="mb-3 text-xs text-fg-subtle">
                {t("dash.otherModelsDesc", { form: "upstreamId/model" })}
              </p>
              {otherGroups.map((grp) => (
                <div key={grp.upstream} className="mb-3">
                  <div className="mb-1 flex items-center gap-1 text-xs text-fg-muted">
                    <span className="font-mono">{grp.upstream}</span>
                    <Badge tone={grp.provider === "azure" ? "brand" : "neutral"}>{grp.provider}</Badge>
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
                        className="rounded-md border border-control bg-background px-2 py-0.5 font-mono text-xs text-fg hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
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
    </Card>
  )
}
