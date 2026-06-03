import { app, type Env } from './src/app.ts'

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>
