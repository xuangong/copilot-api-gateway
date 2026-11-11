import { type RefObject, useRef } from "react"
import { ArrowUp, Paperclip, Square } from "lucide-react"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"
import { cn } from "../../../ui/cn"
import type { VisionSupport } from "../vision"

interface Props {
  editorRef: RefObject<HTMLDivElement | null>
  isEmpty: boolean
  imageError: string
  vision: VisionSupport
  mode: "chat" | "image" | undefined
  streaming: boolean
  onInput: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => Promise<void>
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop: (e: React.DragEvent<HTMLDivElement>) => Promise<void>
  onPickFile: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>
  onSend: () => void
  onStop: () => void
}

/** The contenteditable editor with its attach and send/stop buttons. */
export function ChatComposer({
  editorRef, isEmpty, imageError, vision, mode, streaming,
  onInput, onKeyDown, onDoubleClick, onPaste, onDragOver, onDrop, onPickFile, onSend, onStop,
}: Props) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const attachLabel = t(vision === "yes" || vision === "unknown"
    ? "dash.playground.imageFile"
    : "dash.playground.visionNoHint")
  const sendLabel = streaming ? t("dash.playground.stop") : t("dash.playground.send")
  return (
    <div className="border-t border-border bg-background px-4 pt-3 pb-4">
      <div className="pg-composer rounded-xl border border-input bg-background transition-[border-color,box-shadow] focus-within:border-brand-text focus-within:ring-2 focus-within:ring-brand-text/15">
        <div
          ref={editorRef}
          className="pg-input"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={t("dash.playground.messagePlaceholder")}
          data-placeholder={t("dash.playground.messagePlaceholder")}
          data-empty={isEmpty ? "true" : undefined}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onDoubleClick={onDoubleClick}
          onPaste={(e) => void onPaste(e)}
          onDragOver={onDragOver}
          onDrop={(e) => void onDrop(e)}
        />
        <div className="flex items-center gap-1.5 px-2 pt-1 pb-2">
          {/* A real button, so attaching is reachable by keyboard; the input
              itself stays hidden and is only ever opened from here. */}
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "text-fg-subtle",
              (vision === "no" || vision === "yes-but-rejected") && "text-warn-text hover:text-warn-text",
            )}
            title={attachLabel}
            aria-label={attachLabel}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip aria-hidden="true" />
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => void onPickFile(e)}
          />
          {/* One button, two jobs. While a reply streams the only thing this
              corner can usefully do is stop it — and putting stop where the
              hand already is beats making the user find it in the topbar.
              Composing stays open throughout; it's *sending* that waits.
              Stop drops the brand fill and takes the danger colour, so the
              swap reads at a glance and not only through the changed icon. */}
          <Button
            variant={streaming ? "secondary" : "primary"}
            size="icon"
            onClick={() => {
              if (streaming) onStop()
              else onSend()
            }}
            disabled={!streaming && (isEmpty || mode === undefined)}
            className={cn("ml-auto rounded-lg", streaming && "text-danger")}
            title={sendLabel}
            aria-label={sendLabel}
          >
            {streaming ? <Square className="fill-current" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
          </Button>
        </div>
      </div>
      {imageError && <div role="alert" className="mt-2 text-center text-xs text-danger-text">{imageError}</div>}
    </div>
  )
}
