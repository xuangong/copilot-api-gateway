import { useRef, useState } from "react"
import { fileToDataUrl, ImageTooLargeError } from "../image"
import { putImage } from "../image-store"
import { domToParts, type Part } from "../parts"

// —— Composer (contenteditable) ——
// React can't control a contenteditable without fighting the caret, so the
// editor is uncontrolled: the DOM is the source of truth and we only mirror
// an "is empty" flag out of it for the placeholder and the send button.

export function useComposer(t: (key: string, vars?: Record<string, string | number>) => string) {
  const [isEmpty, setIsEmpty] = useState(true)
  /** Composer holds at least one image → an image-model send becomes an edit. */
  const [hasReference, setHasReference] = useState(false)
  const [imageError, setImageError] = useState("")
  const editorRef = useRef<HTMLDivElement | null>(null)

  function readParts(): Part[] {
    const el = editorRef.current
    return el ? domToParts(el) : []
  }

  function syncEmpty() {
    const parts = readParts()
    setIsEmpty(parts.length === 0)
    setHasReference(parts.some((p) => p.type === "image" && !!p.dataUrl))
  }

  function clearEditor() {
    if (editorRef.current) editorRef.current.innerHTML = ""
    setIsEmpty(true)
    setHasReference(false)
  }

  /** Focus the editor, putting the caret at the end if it isn't already inside. */
  function ensureCaretInEditor() {
    const el = editorRef.current
    if (!el) return
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      el.focus()
      return
    }
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  function setEditorText(s: string) {
    const el = editorRef.current
    if (!el) return
    el.textContent = s
    setIsEmpty(s.trim() === "")
    ensureCaretInEditor()
  }

  // `execCommand` is deprecated but universally implemented, and it is the only
  // insertion API that keeps the browser's native undo stack intact.
  function insertText(s: string) {
    ensureCaretInEditor()
    document.execCommand("insertText", false, s)
    syncEmpty()
  }

  function insertImage(dataUrl: string, id: string) {
    ensureCaretInEditor()
    // Safe to build by concatenation: base64 data URLs contain no `"` or `<`,
    // and the id is our own hex hash.
    document.execCommand(
      "insertHTML",
      false,
      `<img src="${dataUrl}" data-img-id="${id}" class="pg-inline-img" alt="">`,
    )
    syncEmpty()
  }

  /** The single funnel for paste, drop and the 📎 picker. */
  async function insertFiles(files: File[]) {
    setImageError("")
    for (const f of files) {
      try {
        const dataUrl = await fileToDataUrl(f)
        // Store before inserting so the id travels with the image from the
        // first render — a message sent immediately still persists its bytes.
        insertImage(dataUrl, await putImage(dataUrl))
      } catch (err) {
        setImageError(
          err instanceof ImageTooLargeError
            ? t("dash.playground.imageTooLarge")
            : String((err as Error).message),
        )
      }
    }
  }

  async function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const dt = e.clipboardData
    // clipboardData is invalidated the moment we await, so drain it first.
    const files: File[] = []
    for (const item of Array.from(dt.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    e.preventDefault()
    if (files.length > 0) {
      await insertFiles(files)
      return
    }
    // Paste as plain text — pasted HTML would drag foreign markup and inline
    // styles into the composer, and `domToParts` would have to survive them.
    insertText(dt.getData("text/plain"))
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) e.preventDefault()
  }

  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"))
    if (files.length === 0) return
    e.preventDefault()
    // Drop where the pointer is, not where the caret happened to be.
    const caretFrom = (document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }).caretRangeFromPoint
    const range = caretFrom?.call(document, e.clientX, e.clientY)
    if (range && editorRef.current?.contains(range.commonAncestorContainer)) {
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    await insertFiles(files)
  }

  /**
   * Puts one specific thread image into the composer. Sends already inherit the
   * newest image automatically; this is the override for reaching back past it.
   */
  async function insertAsReference(part: Part) {
    if (part.type !== "image" || !part.dataUrl) return
    insertImage(part.dataUrl, part.id ?? await putImage(part.dataUrl))
    editorRef.current?.focus()
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    // Reset first so picking the same file twice in a row still fires onChange.
    e.target.value = ""
    if (files.length > 0) await insertFiles(files)
  }

  return {
    editorRef,
    isEmpty,
    hasReference,
    imageError,
    setImageError,
    readParts,
    syncEmpty,
    clearEditor,
    setEditorText,
    insertText,
    insertImage,
    onPaste,
    onDragOver,
    onDrop,
    insertAsReference,
    onPickFile,
  }
}
