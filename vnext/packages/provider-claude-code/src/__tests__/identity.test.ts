import { describe, expect, test } from 'bun:test'
import { fetchClaudeCodeIdentity } from '../auth/identity'

const jsonResp = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('fetchClaudeCodeIdentity', () => {
  test('happy path flattens account + organization', async () => {
    const fetcher = async () =>
      jsonResp(200, {
        account: { uuid: 'A-UUID', email: 'a@b.com' },
        organization: {
          uuid: 'O-UUID',
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      })
    const id = await fetchClaudeCodeIdentity('TOKEN', fetcher)
    expect(id).toEqual({
      email: 'a@b.com',
      accountUuid: 'A-UUID',
      organizationUuid: 'O-UUID',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    })
  })

  test('personal account (no organization) → null org fields', async () => {
    const fetcher = async () => jsonResp(200, { account: { uuid: 'A', email: 'p@q.com' } })
    const id = await fetchClaudeCodeIdentity('TOKEN', fetcher)
    expect(id.organizationUuid).toBeNull()
    expect(id.subscriptionType).toBeNull()
    expect(id.rateLimitTier).toBeNull()
  })

  test('403 permission_error → degraded deterministic uuid', async () => {
    const fetcher = async () =>
      jsonResp(403, { error: { type: 'permission_error', message: 'no scope' } })
    const id = await fetchClaudeCodeIdentity('TOKEN-XYZ', fetcher)
    expect(id.email).toBeNull()
    expect(id.accountUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    // Determinism: same token → same uuid.
    const id2 = await fetchClaudeCodeIdentity('TOKEN-XYZ', fetcher)
    expect(id2.accountUuid).toBe(id.accountUuid)
  })

  test('unknown organization_type → subscriptionType null (no throw)', async () => {
    const fetcher = async () =>
      jsonResp(200, {
        account: { uuid: 'A', email: 'x@y.com' },
        organization: { uuid: 'O', organization_type: 'claude_future_tier' },
      })
    const id = await fetchClaudeCodeIdentity('T', fetcher)
    expect(id.subscriptionType).toBeNull()
  })

  test('non-403 error throws with status', async () => {
    const fetcher = async () => jsonResp(500, { error: { message: 'boom' } })
    await expect(fetchClaudeCodeIdentity('T', fetcher)).rejects.toThrow(/500/)
  })
})
