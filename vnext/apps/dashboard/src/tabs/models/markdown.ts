// Markdown rendering with safe HTML sanitization and on-demand code highlight.
// Loads only commonly used languages to keep bundle reasonable.
import { createContext } from "react"
import { marked, type Token, type Tokens } from "marked"
import hljs from "highlight.js/lib/core"
import javascript from "highlight.js/lib/languages/javascript"
import typescript from "highlight.js/lib/languages/typescript"
import python from "highlight.js/lib/languages/python"
import json from "highlight.js/lib/languages/json"
import bash from "highlight.js/lib/languages/bash"
import xml from "highlight.js/lib/languages/xml"
import css from "highlight.js/lib/languages/css"
import DOMPurify from "dompurify"
import { cjkStrong } from "./cjk-emphasis"

hljs.registerLanguage("javascript", javascript)
hljs.registerLanguage("js", javascript)
hljs.registerLanguage("typescript", typescript)
hljs.registerLanguage("ts", typescript)
hljs.registerLanguage("python", python)
hljs.registerLanguage("py", python)
hljs.registerLanguage("json", json)
hljs.registerLanguage("bash", bash)
hljs.registerLanguage("sh", bash)
hljs.registerLanguage("shell", bash)
hljs.registerLanguage("html", xml)
hljs.registerLanguage("xml", xml)
hljs.registerLanguage("css", css)

marked.setOptions({
  gfm: true,
  breaks: true,
})

// `**加粗。**后接文字` is literal asterisks under CommonMark's flanking rule.
// See cjk-emphasis.ts for why, and for how narrowly this claws it back.
marked.use({ extensions: [cjkStrong] })

// Custom renderer to apply hljs to fenced code blocks
const renderer = new marked.Renderer()
renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  const language = lang && hljs.getLanguage(lang) ? lang : ""
  const highlighted = language
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : escapeHtml(text)
  const langLabel = language ? `<span class="md-code-lang">${language}</span>` : ""
  return `<pre class="md-code"><code class="hljs">${highlighted}</code>${langLabel}</pre>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * Document levels for one reply's headings, in order. A reply sits under the
 * page's h1 with nothing in between, so its first heading is an h2 (`base`)
 * and none is more than one level below the heading before it: a skip such as
 * h1 → h3 breaks the outline that heading navigation and Lighthouse's
 * heading-order check rely on. Relative depth is kept where that allows.
 */
export function outlineLevels(depths: readonly number[], base = 2): number[] {
  if (depths.length === 0) return []
  const top = Math.min(...depths)
  let previous = base - 1
  return depths.map((depth) => {
    const level = Math.min(base + depth - top, previous + 1, 6)
    previous = level
    return level
  })
}

const isHeading = (token: Token): token is Tokens.Heading => token.type === "heading"
const headingLevels = new WeakMap<Tokens.Heading, number>()

// The tag carries the outline level; the class keeps the size the markdown
// asked for, so `# Title` still looks like a title.
renderer.heading = (token: Tokens.Heading) => {
  const level = headingLevels.get(token) ?? Math.min(token.depth + 1, 6)
  return `<h${level} class="md-h${token.depth}">${renderer.parser.parseInline(token.tokens)}</h${level}>\n`
}

/** Turns rendered markdown into HTML that is safe to inject. */
export type Sanitize = (html: string) => string

export const sanitizeHtml: Sanitize = (html) => DOMPurify.sanitize(html, { ADD_ATTR: ["target"] })

/**
 * The sanitizer chat replies are rendered with. DOMPurify needs a DOM and has
 * no `sanitize` without one, so tests that render the chat provide their own.
 * A context keeps that substitute inside the test's render tree, where
 * replacing the dompurify module would change it for the whole test process.
 */
export const MarkdownSanitizer = createContext<Sanitize>(sanitizeHtml)

export function renderMarkdown(src: string, sanitize: Sanitize = sanitizeHtml): string {
  if (!src) return ""
  // Lexed first so the reply's whole heading outline is known before any of it
  // renders. The parser needs marked.defaults spread in, or it loses the
  // gfm/breaks options and the cjkStrong extension.
  const tokens = marked.lexer(src)
  const headings: Tokens.Heading[] = []
  marked.walkTokens(tokens, (token) => {
    if (isHeading(token)) headings.push(token)
  })
  outlineLevels(headings.map((h) => h.depth)).forEach((level, i) => {
    const heading = headings[i]
    if (heading) headingLevels.set(heading, level)
  })
  return sanitize(marked.parser(tokens, { ...marked.defaults, renderer }))
}
