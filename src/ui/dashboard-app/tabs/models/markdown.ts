// Markdown rendering with safe HTML sanitization and on-demand code highlight.
// Loads only commonly used languages to keep bundle reasonable.
import { marked } from "marked"
import hljs from "highlight.js/lib/core"
import javascript from "highlight.js/lib/languages/javascript"
import typescript from "highlight.js/lib/languages/typescript"
import python from "highlight.js/lib/languages/python"
import json from "highlight.js/lib/languages/json"
import bash from "highlight.js/lib/languages/bash"
import xml from "highlight.js/lib/languages/xml"
import css from "highlight.js/lib/languages/css"
import DOMPurify from "dompurify"

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

export function renderMarkdown(src: string): string {
  if (!src) return ""
  const html = marked.parse(src, { renderer, async: false }) as string
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
  })
}
