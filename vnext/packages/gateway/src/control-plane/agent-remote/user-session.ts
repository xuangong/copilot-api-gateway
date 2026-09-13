import { getRepo } from "../../repo/index.ts"
import type { SessionToken } from "../../repo/branded-ids.ts"

export async function userSession(request: Request) {
  const authorization = request.headers.get('authorization')
  const token = authorization ? /^Bearer (ses_[^\s]+)$/i.exec(authorization)?.[1]
    : /(?:^|;\s*)session_token=(ses_[^\s;]+)/.exec(request.headers.get('cookie') ?? '')?.[1]
  if (!token || token.length > 4096) return undefined
  const repo = getRepo()
  const session = await repo.sessions.findByToken(token as SessionToken)
  if (!session || !(Date.parse(session.expiresAt) > Date.now())) return undefined
  const user = await repo.users.getById(session.userId)
  return user && !user.disabled ? { user, session } : undefined
}
