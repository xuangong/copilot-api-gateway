/**
 * Docker Model Runner compatibility layer — switch and scope.
 *
 * DMR is a machine-local, unauthenticated service (default
 * `http://127.0.0.1:12434`), and the clients that speak to it are built on
 * that assumption: AnythingLLM's provider constructs its OpenAI client with
 * `apiKey: null` and sends a literal `Authorization: Bearer null`. It also
 * rewrites whatever base path you configure to `engines/v1`, so there is no
 * header, path or query channel left through which a caller could hand us a
 * key. The identity therefore has to come from the server side: one key bound
 * in the environment, and the whole layer gated behind `DMR_COMPAT` so it only
 * exists on LAN deployments that opt in. Unset means the code paths below
 * never activate and the gateway behaves byte-identically to before.
 */

/** Reads env defensively — workerd has `process.env` under nodejs_compat, but not every host does. */
function env(name: string): string | undefined {
  try {
    return process.env[name] || undefined
  } catch {
    return undefined
  }
}

/** Master switch. Nothing in the DMR layer mounts or applies when this is off. */
export function isDmrCompatEnabled(): boolean {
  return Boolean(env('DMR_COMPAT'))
}

/** The API key every DMR-surface request is attributed to. */
export function dmrBoundKey(): string | undefined {
  return env('DMR_BOUND_KEY')
}

/**
 * Whether `pathname` belongs to the DMR compatibility surface.
 *
 * Deliberately excludes `/v1/*`: that is the gateway's ordinary public API,
 * and letting the bound key apply there would turn every unauthenticated
 * request into an authenticated one — an open relay. Only paths a real DMR
 * server would answer are in scope.
 */
export function isDmrPath(pathname: string): boolean {
  return (
    pathname.startsWith('/engines/') ||
    pathname.startsWith('/anthropic/') ||
    pathname === '/models' ||
    pathname.startsWith('/models/')
  )
}
