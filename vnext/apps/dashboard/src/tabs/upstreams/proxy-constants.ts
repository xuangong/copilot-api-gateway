/**
 * The two built-in chain entries. Neither has a row in the `proxies` table —
 * the dialer special-cases both ids (see packages/proxy-repo/src/fallback-list.ts,
 * which exports the same literals as DIRECT_CONNECT_ID / DIRECT_FETCH_ID).
 * Duplicated here so the browser bundle does not pull in a server package.
 */
export const DIRECT_CONNECT_ID = "direct_connect"
export const DIRECT_FETCH_ID = "direct_fetch"

export const BUILT_IN_PROXY_IDS: readonly string[] = [DIRECT_CONNECT_ID, DIRECT_FETCH_ID]
