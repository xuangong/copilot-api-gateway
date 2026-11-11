import type { CSSProperties } from "react"
import { ChevronDown, ChevronUp, Download, ImageOff, Pencil, Search, Undo2 } from "lucide-react"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"
import { cn } from "../../../ui/cn"
import { Tooltip } from "../../../ui/tooltip"
import type { Part } from "../parts"
import type { Citation } from "../streams/openai"
import { downloadImage, imageFilename } from "../download"
import { renderMarkdown } from "../markdown"
import { avatarAccent, avatarLabel } from "../avatar"
import { PerformanceDetails } from "../PerformanceDetails"
import { COLLAPSED_SOURCE_COUNT, hostOf, messageParts, type Message } from "./chat-state"

interface Props {
  /** Attaches the resize observer that keeps the thread pinned to the bottom. */
  threadRef: (node: HTMLDivElement | null) => void
  messages: Message[]
  streaming: boolean
  mode: "chat" | "image" | undefined
  expandedSources: ReadonlySet<number>
  copiedIdx: number | null
  openedAt: Date
  onRetract: (index: number, parts: Part[]) => void
  onZoom: (src: string) => void
  onUseAsReference: (part: Part) => void
  onToggleSources: (index: number) => void
  onCopy: (index: number, text: string) => void
}

export function ChatThread({ threadRef, messages, ...row }: Props) {
  return (
    <div ref={threadRef} className="pg-thread">
      {messages.map((m, i) => (
        <MessageRow key={i} m={m} i={i} isLast={i === messages.length - 1} {...row} />
      ))}
    </div>
  )
}

/**
 * Hidden until the row (or image) is hovered, so an undo or a copy doesn't sit
 * in reach of every stray click — but shown whenever focus is inside, so a
 * keyboard user can see what they tabbed to, and always on touch, which has
 * no hover to reveal it.
 */
const REVEAL = "opacity-0 transition-opacity focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
const REVEAL_IN_ROW = cn(REVEAL, "group-hover/row:opacity-100 group-focus-within/row:opacity-100")
const REVEAL_IN_IMAGE = cn(REVEAL, "group-hover/img:opacity-100 group-focus-within/img:opacity-100")
/** Dark chip over an arbitrary image: theme colours can't promise contrast there. */
const IMAGE_BUTTON = cn(
  "absolute top-1.5 rounded-md bg-black/55 text-white hover:bg-black/80 hover:text-white [&_svg]:size-3.5",
  REVEAL_IN_IMAGE,
)

type RowProps = Omit<Props, "threadRef" | "messages"> & { m: Message; i: number; isLast: boolean }

function MessageRow({
  m, i, isLast, streaming, mode, expandedSources, copiedIdx, openedAt, onRetract, onZoom, onUseAsReference, onToggleSources, onCopy,
}: RowProps) {
  const t = useT()
  const isAssistant = m.role === "assistant"
  const showDots = isAssistant && streaming && isLast && !m.text
  return (
    <div className={"pg-row group/row" + (m.role === "user" ? " pg-row-user" : "")}>
      {isAssistant && (() => {
        const label = avatarLabel(m.model)
        return (
          <div
            className="pg-avatar"
            style={{ "--pg-accent": avatarAccent(label) } as CSSProperties}
          >
            {label}
          </div>
        )
      })()}
      {!isAssistant && (
        <Tooltip content={<span className="block max-w-60">{t("dash.playground.retractTitle")}</span>} side="top">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("dash.playground.retractTitle")}
            onClick={() => onRetract(i, messageParts(m))}
            className={cn("shrink-0 self-center [&_svg]:size-3.5", REVEAL_IN_ROW)}
          >
            <Undo2 aria-hidden="true" />
          </Button>
        </Tooltip>
      )}
      <div
        className={cn(
          "relative text-sm leading-[1.6]",
          m.role === "user"
            ? "max-w-[78%] rounded-[18px_18px_4px_18px] border border-brand-text/20 bg-brand-text/10 px-3.5 py-2.5"
            : "min-w-0 flex-1 rounded-[4px_18px_18px_18px] border border-border bg-panel px-3.5 py-2.5",
        )}
      >
        {showDots ? (
          <span className="pg-dots text-fg-subtle"><span/><span/><span/></span>
        ) : m.parts ? (
          <div className="whitespace-pre-wrap">
            {m.parts.map((p, pi) =>
              p.type === "text" ? (
                <span key={pi}>{p.text}</span>
              ) : p.dataUrl ? (
                <span key={pi} className="group/img relative inline-block leading-[0]">
                  <button
                    type="button"
                    onClick={() => onZoom(p.dataUrl)}
                    title={t("dash.playground.zoomImage")}
                    aria-label={t("dash.playground.zoomImage")}
                    className={cn(
                      "cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
                      isAssistant ? "block" : "inline-block",
                    )}
                  >
                    <img src={p.dataUrl} alt="" className={isAssistant ? "pg-gen-img" : "pg-inline-img"} />
                  </button>
                  {mode === "image" && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className={cn(IMAGE_BUTTON, "right-[38px]")}
                      title={t("dash.playground.useAsReference")}
                      aria-label={t("dash.playground.useAsReference")}
                      onClick={() => onUseAsReference(p)}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn(IMAGE_BUTTON, "right-1.5")}
                    title={t("dash.playground.download")}
                    aria-label={t("dash.playground.download")}
                    onClick={() => void downloadImage(
                      p.dataUrl,
                      imageFilename(p.dataUrl, openedAt, pi),
                    )}
                  >
                    <Download aria-hidden="true" />
                  </Button>
                </span>
              ) : (
                // The bytes are gone from the store — the position
                // survives so the message still reads correctly.
                <span
                  key={pi}
                  role="img"
                  aria-label={t("dash.playground.imagePlaceholder")}
                  className="pg-img-placeholder"
                  title={t("dash.playground.imagePlaceholder")}
                >
                  <ImageOff className="inline size-3.5 align-[-2px]" aria-hidden="true" />
                </span>
              ),
            )}
          </div>
        ) : isAssistant ? (
          <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
        ) : (
          <div className="whitespace-pre-wrap">{m.text}</div>
        )}
        {isAssistant && m.webSearches && m.webSearches.length > 0 && (
          <div className="pg-tool-list">
            {m.webSearches.map((w) => (
              <div key={w.id} className={"pg-tool pg-tool-" + w.status}>
                <Search className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="pg-tool-label">
                  {w.status === "completed" ? "Searched" : w.status === "searching" ? "Searching" : "Preparing search"}
                </span>
                {w.query && <span className="pg-tool-query">"{w.query}"</span>}
              </div>
            ))}
          </div>
        )}
        {isAssistant && m.citations && m.citations.length > 0 && (
          <SourceList
            all={m.citations}
            expanded={expandedSources.has(i)}
            onToggle={() => onToggleSources(i)}
          />
        )}
        {isAssistant && m.performance && <PerformanceDetails snapshot={m.performance} />}
        {isAssistant && (m.text || m.usage || m.durationMs != null) && (
          <div className="mt-2 flex min-h-[19px] items-center justify-between gap-3 font-mono text-xs tabular-nums text-fg-subtle">
            {(m.usage || m.durationMs != null) &&
              t("dash.playground.usage", {
                tin: (m.performance ? m.performance.metrics.inputTokens : m.usage?.input_tokens) ?? "—",
                tout: (m.performance ? m.performance.metrics.outputTokens : m.usage?.output_tokens) ?? "—",
                ms: m.durationMs ?? "—",
              })}
            {m.text && (
              <Button
                variant="secondary"
                size="sm"
                className={cn("ml-auto h-6 shrink-0 px-1.5 text-xs font-normal text-fg-subtle hover:text-fg", REVEAL_IN_ROW)}
                onClick={() => onCopy(i, m.text)}
                title={t("dash.playground.copy")}
              >
                {copiedIdx === i ? t("dash.playground.copied") : t("dash.playground.copy")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** A source link (or the fold toggle) in the list under a reply. */
const SOURCE_CHIP =
  "inline-flex w-fit max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"

/** The turn's cited sources, folded to the first few until expanded. */
function SourceList({ all, expanded, onToggle }: { all: Citation[]; expanded: boolean; onToggle: () => void }) {
  const t = useT()
  const hidden = all.length - COLLAPSED_SOURCE_COUNT
  const shown = expanded ? all : all.slice(0, COLLAPSED_SOURCE_COUNT)
  return (
    <div className="pg-tool-list">
      {shown.map((c, ci) => (
        <a
          key={c.url}
          className={cn(SOURCE_CHIP, "text-fg hover:border-control hover:text-brand-text")}
          href={c.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="tabular-nums text-fg-subtle">{ci + 1}</span>
          <span className="min-w-0 truncate">{c.title || hostOf(c.url)}</span>
        </a>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className={cn(SOURCE_CHIP, "cursor-pointer text-fg-subtle hover:text-fg")}
          onClick={onToggle}
          aria-expanded={expanded}
        >
          {expanded
            ? <ChevronUp className="size-3.5 shrink-0" aria-hidden="true" />
            : <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />}
          <span>
            {expanded
              ? t("dash.playground.sourcesFewer")
              : t("dash.playground.sourcesMore", { n: hidden })}
          </span>
        </button>
      )}
    </div>
  )
}
