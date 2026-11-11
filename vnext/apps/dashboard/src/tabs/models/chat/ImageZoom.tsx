import * as RadixDialog from "@radix-ui/react-dialog"
import { Download, X } from "lucide-react"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"
import { cn } from "../../../ui/cn"
import { downloadImage, imageFilename } from "../download"

interface Props {
  /** Data URL of the zoomed image. */
  src: string
  /** When the thread was opened — names the download. */
  openedAt: Date
  onClose: () => void
}

/** Light chip over the dark backdrop: theme colours can't promise contrast there. */
const OVERLAY_BUTTON =
  "absolute top-4 size-9 rounded-full bg-white/15 text-white hover:bg-white/30 hover:text-white focus-visible:outline-white"

/**
 * Full-size view of one image, as a modal dialog: focus moves in and comes
 * back, and Esc closes it. Radix marks that Esc as used, so in fullscreen the
 * same press doesn't also leave fullscreen (see `escapeExitsFullscreen`).
 * Any click outside the save button closes it — the image included.
 */
export function ImageZoom({ src, openedAt, onClose }: Props) {
  const t = useT()
  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm" />
        <RadixDialog.Content
          aria-describedby={undefined}
          onClick={onClose}
          className="fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center p-8 focus:outline-none"
        >
          <RadixDialog.Title className="sr-only">{t("dash.playground.zoomTitleAria")}</RadixDialog.Title>
          <img src={src} alt="" className="max-h-full max-w-full rounded-lg shadow-2xl" />
          <Button
            variant="ghost"
            size="icon"
            className={cn(OVERLAY_BUTTON, "right-16")}
            title={t("dash.playground.download")}
            aria-label={t("dash.playground.download")}
            onClick={(e) => {
              // A click anywhere closes the view; saving shouldn't also dismiss it.
              e.stopPropagation()
              void downloadImage(src, imageFilename(src, openedAt, 0))
            }}
          >
            <Download aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(OVERLAY_BUTTON, "right-5")}
            title={t("dash.playground.closeZoom")}
            aria-label={t("dash.playground.closeZoom")}
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
