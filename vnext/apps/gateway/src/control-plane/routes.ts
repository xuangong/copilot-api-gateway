/**
 * Control-plane router scaffold — Week 5a.
 *
 * Mounts the management/ops API surface (dashboard-facing). Subroutes are
 * intentionally empty placeholders at this scaffold stage; each will be
 * populated 1:1 from the old project's src/routes/{...}.ts in Week 5.
 *
 * Why scaffold first: the old project's control-plane.ts (~440 LOC) +
 * api-keys.ts (~560 LOC) + upstream-accounts.ts (~100 LOC) +
 * observability-shares.ts (~70 LOC) lump unrelated concerns into one or
 * two files. Splitting into subdirs now lets each port land independently
 * without rebasing app.ts each time.
 *
 * Strict boundary (enforced by ESLint no-restricted-paths in plan): no
 * import from data-plane/. Control-plane only touches shared/repo + shared/lib.
 */
import { Hono } from 'hono'
import type { Env } from '../app.ts'
import { upstreamsRouter, upstreamMiscRouter } from './upstreams/routes.ts'
import { apiKeysRouter } from './api-keys/routes.ts'
import { observabilitySharesRouter } from './observability-shares/routes.ts'
import { authRouter } from './auth/routes.ts'
import { githubAccountsRouter } from './github-accounts/routes.ts'

export const controlPlane = new Hono<{ Bindings: Env }>()

controlPlane.route('/api/upstreams', upstreamsRouter)
controlPlane.route('/api', upstreamMiscRouter)
controlPlane.route('/api/keys', apiKeysRouter)
controlPlane.route('/api/observability-shares', observabilitySharesRouter)
// Old dashboard hits /auth/login etc. (no /api prefix). Keep both mounts:
// /api/auth for vNext-internal alignment, /auth for byte-identical dashboard contract.
controlPlane.route('/api/auth', authRouter)
controlPlane.route('/auth', authRouter)
// NOTE: Mounted at /api/upstream-accounts to match old dashboard contract
// (src/routes/upstream-accounts.ts). Subdir name stays `github-accounts/`
// since the table backing it is `github_accounts`.
controlPlane.route('/api/upstream-accounts', githubAccountsRouter)
