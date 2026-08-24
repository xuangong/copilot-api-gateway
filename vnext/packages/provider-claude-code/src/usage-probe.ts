// Active quota probe against Anthropic's `GET /api/oauth/usage`.
//
// Real `@anthropic-ai/claude-code` calls this endpoint directly (binary string
// `fetchUtilization: GET /api/oauth/usage`), so mirroring it gives operators a
// clean snapshot of the rate-limit windows without burning a model call — and
// keeps our traffic shaped like the CLI's rather than inventing a probe pattern
// the real client never emits.
//
// Cross-checked against sub2api
// `backend/internal/repository/claude_usage_service.go`, which hardcodes the
// same URL and replays the same headers.
//
// Ported from copilot-gateway `packages/provider-claude-code/src/usage-probe.ts`.
//
// Wire format is roughly `{five_hour: {utilization, resets_at}, seven_day: {…},
// seven_day_sonnet: {…}, seven_day_opus: {…}}` plus optional overage fields. We
// deliberately do NOT assert the inner shape: Anthropic has been adding fields
// (priorIsUsingOverage, hadPriorUtilizationData, …) without warning, and a
// strict parser would reject a perfectly usable new field as malformed. The
// consumer walks the field names it knows and ignores the rest.
import { CLAUDE_CODE_OAUTH_USER_AGENT, CLAUDE_CODE_USAGE_PROBE_URL } from './constants'
import type { Fetcher } from './fetcher'

export interface ClaudeCodeUsageProbeResult {
  /** Stamped here so a persisted snapshot can be shown with its staleness. */
  fetched_at: string
  /** The upstream body verbatim — `unknown` because the shape evolves. */
  body: unknown
}

export const fetchClaudeCodeUsageProbe = async (
  accessToken: string,
  fetcher: Fetcher,
): Promise<ClaudeCodeUsageProbeResult> => {
  const response = await fetcher(CLAUDE_CODE_USAGE_PROBE_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      // The CLI's probe rides on axios rather than its own claude-cli UA.
      'user-agent': CLAUDE_CODE_OAUTH_USER_AGENT,
      // The only non-trivial requirement: without `oauth-2025-04-20` the
      // endpoint returns 401 even for a valid bearer.
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    },
  })

  const rawText = await response.text()
  if (!response.ok) {
    // Truncated: the failure body can be a full HTML error page, and the
    // message ends up in operator-facing output.
    throw new Error(
      `Claude Code /api/oauth/usage returned ${response.status}: ${rawText.slice(0, 256)}`,
    )
  }

  let parsed: unknown
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : null
  } catch (cause) {
    throw new Error(`Claude Code /api/oauth/usage returned non-JSON body (${response.status})`, {
      cause,
    })
  }
  // `null` and arrays parse fine but carry no usage windows; persisting one
  // would leave a snapshot the consumer cannot render.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Claude Code /api/oauth/usage returned a non-object body (${response.status})`)
  }

  return { fetched_at: new Date().toISOString(), body: parsed }
}
