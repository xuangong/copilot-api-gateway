/**
 * Content model for the playground composer.
 *
 * The composer is a `contenteditable` div, so a message is an ordered mix of
 * text runs and inline images. `Part[]` is that order made explicit — every
 * protocol serializer downstream (see `payload.ts`) consumes it, which is what
 * keeps `text → image → text` interleaving intact across OpenAI / Anthropic /
 * Gemini.
 */

export type Part =
  | { type: "text"; text: string }
  /** `id` is the IndexedDB key holding the bytes; absent until the image is stored. */
  | { type: "image"; dataUrl: string; id?: string }

/**
 * The structural subset of `Node` that `domToParts` walks.
 *
 * Real DOM nodes satisfy this by structural typing, so the walker stays a pure
 * function testable with plain object literals — no jsdom/happy-dom needed.
 */
export interface ComposerNode {
  nodeType: number
  nodeName: string
  textContent?: string | null
  childNodes?: ArrayLike<ComposerNode>
  getAttribute?: (name: string) => string | null
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3

// Browsers wrap each line of a contenteditable in one of these, so crossing
// into one is a line break in the flattened text.
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "DD", "DT",
  "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR",
  "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL",
])

export function domToParts(root: ComposerNode): Part[] {
  const parts: Part[] = []
  let buf = ""

  const flush = () => {
    if (buf) {
      parts.push({ type: "text", text: buf })
      buf = ""
    }
  }

  const walk = (node: ComposerNode, isRoot: boolean) => {
    if (node.nodeType === TEXT_NODE) {
      buf += node.textContent ?? ""
      return
    }
    if (node.nodeType !== ELEMENT_NODE) return

    const tag = node.nodeName.toUpperCase()
    if (tag === "BR") {
      buf += "\n"
      return
    }
    if (tag === "IMG") {
      const src = node.getAttribute?.("src")
      if (src) {
        flush()
        const id = node.getAttribute?.("data-img-id")
        parts.push(id ? { type: "image", dataUrl: src, id } : { type: "image", dataUrl: src })
      }
      return
    }
    // A block boundary only breaks a line when there is something before it.
    if (!isRoot && BLOCK_TAGS.has(tag) && (buf !== "" || parts.length > 0)) {
      buf += "\n"
    }
    const kids = node.childNodes
    if (kids) {
      for (let i = 0; i < kids.length; i++) walk(kids[i]!, false)
    }
  }

  walk(root, true)
  flush()
  return normalize(parts)
}

/**
 * Drops text runs that carry no content (the newline browsers leave between
 * two pasted images, for instance) and trims the message as a whole. Interior
 * spacing next to an image is load-bearing, so it survives.
 */
function normalize(parts: Part[]): Part[] {
  const kept = parts.filter((p) => p.type !== "text" || p.text.trim() !== "")
  const first = kept[0]
  if (first?.type === "text") kept[0] = { type: "text", text: first.text.replace(/^\s+/, "") }
  const last = kept[kept.length - 1]
  if (last?.type === "text") {
    kept[kept.length - 1] = { type: "text", text: last.text.replace(/\s+$/, "") }
  }
  return kept
}

/** Flattened text of a message — used for the copy button and retry labels. */
export function partsToText(parts: Part[]): string {
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("")
}

/** `data:image/png;base64,AAAA` → `{ mime, data }`; null for anything else. */
export function splitDataUrl(url: string): { mime: string; data: string } | null {
  if (!url.startsWith("data:")) return null
  const comma = url.indexOf(",")
  if (comma < 0) return null
  const meta = url.slice(5, comma)
  const data = url.slice(comma + 1)
  return { mime: meta.split(";")[0] || "image/png", data }
}
