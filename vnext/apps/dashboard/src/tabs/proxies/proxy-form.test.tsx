import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ProxyForm } from "./ProxyForm"
import type { ProxyDraft } from "./proxy-form-config"

// Outside a browser useT() returns the key itself, so names below are i18n keys.
const trojan: ProxyDraft = {
  name: "n1",
  config: { kind: "trojan", name: "n1", host: "h", port: 443, password: "pw" },
  url: null,
  dialTimeoutSeconds: "",
}
const render = (draft: ProxyDraft) => renderToStaticMarkup(<ProxyForm draft={draft} onChange={() => {}} />)

test("a proxy password is masked, kept out of autofill, and has a show toggle", () => {
  const html = render(trojan)
  const password = html.match(/<input[^>]*type="password"[^>]*>/)?.[0] ?? ""
  // React writes the attribute as autoComplete; HTML attribute names ignore case.
  expect(password).toMatch(/autocomplete="new-password"/i)
  const toggle = html.match(/<button[^>]*aria-label="dash\.proxyShowPassword"[^>]*>/)?.[0] ?? ""
  expect(toggle).toContain('aria-pressed="false"')
})

const UUID = "00000000-0000-4000-8000-000000000000"
const vless: Array<ProxyDraft["config"]> = [
  { kind: "vless-tcp", name: "n1", host: "h", port: 443, uuid: UUID },
  { kind: "vless-ws", name: "n1", host: "h", port: 443, uuid: UUID, path: "/" },
  { kind: "reality", name: "n1", host: "h", port: 443, uuid: UUID, publicKey: "pbk", serverName: "sni.example.com" },
]

test.each(vless)("a VLESS UUID is the credential, so it is masked with its own toggle ($kind)", (config) => {
  const html = render({ ...trojan, config })
  const uuid = html.match(/<input[^>]*type="password"[^>]*>/)?.[0] ?? ""
  expect(uuid).toContain(`value="${UUID}"`)
  expect(html).toContain('aria-label="dash.proxyShowUuid"')
})

test("the ss2022 PSK toggle is named for the PSK", () => {
  const html = render({
    ...trojan,
    config: { kind: "ss2022", name: "n1", host: "h", port: 8388, method: "2022-blake3-aes-128-gcm", passwordBase64: "cGFzcw==" },
  })
  expect(html).toContain('aria-label="dash.proxyShowPsk"')
})

// A number keypad on phones, but not type=number: a focused spin box changes
// the port when the page is scrolled over it, and ArrowUp from empty gives 1.
// The range is checked by draftIssues like every other field.
test("the port asks for digits without being a spin box", () => {
  const port = render(trojan).match(/<input[^>]*value="443"[^>]*>/)?.[0] ?? ""
  expect(port).toContain('type="text"')
  expect(port).toMatch(/inputmode="numeric"/i)
})
