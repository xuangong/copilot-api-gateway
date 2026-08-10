/**
 * Zod-validated Hono middleware — canonical `{ error: msg }` 400 response.
 *
 * Wrap `@hono/zod-validator` so validation failures return our canonical
 * `{ error: msg }` 400 shape — matching what hand-written control-plane
 * validators returned before. Without the wrapper, zValidator's default
 * response includes the full ZodError tree, too noisy for the dashboard's
 * inline error UI.
 *
 * The two `CtxWith*` aliases let handlers declared in separate files type
 * `c.req.valid('json' | 'query')` precisely without restating the Env /
 * Variables / Path generics.
 *
 * The optional `Path` generic threads the route's literal path through to
 * Hono's Context so `c.req.param('id')` narrows to `string` (not `string |
 * undefined`) on routes that declare `:id`.
 */
import { zValidator as zValidatorBase } from '@hono/zod-validator'
import type { Context, ValidationTargets } from 'hono'
import type { z, ZodType } from 'zod'

import type { Env } from '../../app.ts'
import type { AuthCtx } from '../auth/routes.ts'

type Vars = { auth: AuthCtx }

export const zValidator = <T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidatorBase(target, schema, (result, c) => {
    if (!result.success) {
      const issue = result.error.issues[0]
      return c.json({ error: issue?.message ?? 'Invalid input' }, 400)
    }
  })

export type CtxWithJson<S extends ZodType, Path extends string = string> = Context<
  { Bindings: Env; Variables: Vars },
  Path,
  { in: { json: z.infer<S> }; out: { json: z.infer<S> } }
>

export type CtxWithQuery<S extends ZodType, Path extends string = string> = Context<
  { Bindings: Env; Variables: Vars },
  Path,
  { in: { query: z.infer<S> }; out: { query: z.infer<S> } }
>
