import { Image as ImageIcon, ImageOff, Maximize2, Minimize2 } from "lucide-react"
import { useT } from "../../../state/i18n"
import { Badge } from "../../../ui/badge"
import { Button } from "../../../ui/button"
import { cn } from "../../../ui/cn"
import { SegmentedControl, type SegmentedOption } from "../../../ui/segmented-control"
import { Select, type SelectOption } from "../../../ui/select"
import { buildImageContext, type ImageParams } from "../images"
import type { VisionSupport } from "../vision"
import { ImageParamsBar } from "../ImageParamsBar"
import { contextPercent, contextPressure, formatTokens } from "../tokens"
import type { Message, Protocol } from "./chat-state"

const PROTOCOL_OPTIONS: ReadonlyArray<SegmentedOption<Protocol>> = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
]

const VISION_TONE = {
  yes: "success",
  unknown: "neutral",
  no: "danger",
  "yes-but-rejected": "danger",
} as const satisfies Record<VisionSupport, "success" | "neutral" | "danger">

/** Colour only once the headroom actually matters: a permanently tinted number stops being a signal. */
const PRESSURE_CLASS = {
  ok: "text-fg-muted",
  warn: "text-warn-text",
  full: "font-semibold text-danger-text",
} as const

interface Props {
  fullscreen: boolean
  modelId: string
  modelOptions: SelectOption[]
  onPickModel: (id: string) => void
  mode: "chat" | "image" | undefined
  imageParams: ImageParams
  onImageParamsChange: (next: ImageParams) => void
  /** Composer holds a reference image. */
  hasReference: boolean
  messages: Message[]
  protocol: Protocol
  onProtocol: (p: Protocol) => void
  vision: VisionSupport
  streaming: boolean
  ctxCounting: boolean
  ctxTokens: number | null
  contextWindow: number | undefined
  onCompact: () => void
  onStop: () => void
  onClear: () => void
  onToggleFullscreen: () => void
}

export function ChatTopbar({
  fullscreen, modelId, modelOptions, onPickModel, mode, imageParams, onImageParamsChange, hasReference, messages,
  protocol, onProtocol, vision, streaming, ctxCounting, ctxTokens, contextWindow, onCompact, onStop, onClear, onToggleFullscreen,
}: Props) {
  const t = useT()
  const fullscreenLabel = fullscreen ? t("dash.playground.exitFullscreen") : t("dash.playground.fullscreen")
  return (
    <div className="pg-topbar">
      {/*
        Only in fullscreen: everywhere else the sidebar list is the picker,
        and a second control for the same thing would just be one more place
        for the two to disagree.
      */}
      {fullscreen && modelOptions.length > 0 && (
        <div className="pg-fs-model">
          <Select
            value={modelId}
            options={modelOptions}
            onChange={onPickModel}
            ariaLabel={t("dash.model")}
            size="sm"
          />
        </div>
      )}

      {mode === "image" && (
        <ImageParamsBar
          params={imageParams}
          onChange={onImageParamsChange}
          editing={hasReference || buildImageContext(messages).refs.length > 0}
          disabled={streaming}
        />
      )}
      {mode === "chat" && (
        <>
          <span className="text-fg-subtle">{t("dash.playground.protocol")}:</span>
          <SegmentedControl
            options={PROTOCOL_OPTIONS}
            value={protocol}
            onChange={onProtocol}
            ariaLabel={t("dash.playground.protocol")}
            size="sm"
          />
          <span
            className="ml-1 cursor-help"
            title={t(
              vision === "yes" ? "dash.playground.visionYesHint"
                : vision === "unknown" ? "dash.playground.visionUnknownHint"
                  : "dash.playground.visionNoHint",
            )}
          >
            <Badge tone={VISION_TONE[vision]} className="gap-1 [&_svg]:size-3.5">
              {vision === "yes" || vision === "unknown"
                ? <ImageIcon aria-hidden="true" />
                : <ImageOff aria-hidden="true" />}
              {t(
                vision === "yes" ? "dash.playground.visionYes"
                  : vision === "unknown" ? "dash.playground.visionUnknown"
                    : "dash.playground.visionNo",
              )}
            </Badge>
          </span>
        </>
      )}
      {streaming && (
        <span role="status" className="ml-2 flex items-center gap-2 text-fg-subtle">
          <span className="pg-dots"><span/><span/><span/></span>
          {t("dash.playground.generating")}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {mode === "chat" && messages.length > 0 && (() => {
          if (ctxCounting) {
            return (
              <span className="mr-2 font-mono text-xs tabular-nums text-fg-subtle">
                {t("dash.playground.ctxCounting")}
              </span>
            )
          }
          // No count yet, or no ceiling reported: show what we have rather
          // than a made-up denominator.
          if (ctxTokens == null || !contextWindow) {
            return (
              <span className="mr-2 font-mono text-xs tabular-nums text-fg-subtle">
                {t("dash.playground.ctxTokens", { n: ctxTokens ?? "—" })}
              </span>
            )
          }
          const pressure = contextPressure(ctxTokens, contextWindow)
          return (
            <span
              className={cn("mr-2 font-mono text-xs tabular-nums", PRESSURE_CLASS[pressure])}
              title={t("dash.playground.ctxTitle", {
                left: Math.max(0, contextWindow - ctxTokens),
              })}
            >
              {t("dash.playground.ctxTokensOf", {
                n: ctxTokens,
                limit: formatTokens(contextWindow),
                pct: contextPercent(ctxTokens, contextWindow),
              })}
            </span>
          )
        })()}
        {messages.length >= 4 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCompact}
            disabled={streaming}
            title={t("dash.playground.compactTitle")}
          >
            {t("dash.playground.compact")}
          </Button>
        )}
        {streaming && (
          <Button variant="ghost" size="sm" onClick={onStop}>
            {t("dash.playground.stop")}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClear}>
          {t("dash.playground.clear")}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleFullscreen}
          aria-label={fullscreenLabel}
          title={fullscreenLabel}
        >
          {fullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </Button>
      </div>
    </div>
  )
}
