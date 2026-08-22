/**
 * Saving an image out of the playground.
 *
 * Split from the components so the filename rule — the part that silently
 * produces something wrong rather than failing — is testable.
 */

import { splitDataUrl } from "./parts"

const KNOWN_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg"])

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * `playground-<yyyymmdd>-<hhmmss>[-<n>].<ext>` — sorts chronologically in a
 * downloads folder, and stays away from the prompt text, which would need
 * escaping and could leak into a filename anything the user typed.
 */
export function imageFilename(url: string, at: Date, index: number): string {
  const stamp =
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
  const suffix = index > 0 ? `-${index + 1}` : ""
  return `playground-${stamp}${suffix}.${extensionFor(url)}`
}

function extensionFor(url: string): string {
  const data = splitDataUrl(url)
  if (data) {
    const sub = data.mime.split("/")[1]?.split("+")[0]?.toLowerCase()
    return sub && KNOWN_EXTENSIONS.has(sub) ? sub : "png"
  }
  const path = url.split("?")[0] ?? ""
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return KNOWN_EXTENSIONS.has(ext) ? ext : "png"
}

/**
 * Data URLs download straight from an anchor. A remote URL can't: the browser
 * ignores `download` cross-origin and navigates instead, so fetch it into a
 * blob first and fall back to opening it if that is blocked.
 */
export async function downloadImage(url: string, filename: string): Promise<void> {
  let href = url
  let revoke = false
  if (!url.startsWith("data:")) {
    try {
      href = URL.createObjectURL(await (await fetch(url)).blob())
      revoke = true
    } catch {
      window.open(url, "_blank", "noopener")
      return
    }
  }
  const a = document.createElement("a")
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  if (revoke) URL.revokeObjectURL(href)
}
