export interface ClickLike {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}

/**
 * Whether a click on an in-app link should be handled as in-page navigation.
 * Modified or non-primary clicks (new tab, new window, download) are left to
 * the browser, and so is a click something else already handled.
 */
export function isPlainLeftClick(e: ClickLike): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented
}
