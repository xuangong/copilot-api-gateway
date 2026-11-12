// Test-only. Loads the real window.t() and both dictionaries from the gateway's
// page script, so a test can check the words a user reads, in either language.
// Without it t() returns the bare key.
import { renderI18nScript } from "../../../../packages/gateway/src/shared/edge/ui-pages/i18n"

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Installs window.t and window.__lang for `lang`; call what it returns to undo. */
export function installDictionary(lang: "en" | "zh"): () => void {
  const body = renderI18nScript().replace(/^<script>/, "").replace(/<\/script>$/, "")
  const fakeWindow: { t?: Translate; __lang?: string } = {}
  const run = new Function("window", "localStorage", "navigator", "document", `${body}\nreturn t`)
  fakeWindow.t = run(fakeWindow, { getItem: () => lang }, { language: "en-US" }, { documentElement: { setAttribute() {} } }) as Translate
  const scope = globalThis as { window?: unknown }
  const had = "window" in scope
  const previous = scope.window
  scope.window = fakeWindow
  return () => {
    if (had) scope.window = previous
    else delete scope.window
  }
}
