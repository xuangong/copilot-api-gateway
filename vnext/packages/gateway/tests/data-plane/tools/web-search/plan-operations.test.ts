/**
 * One shim `function_call` can ask for several things at once — the tool
 * description explicitly invites it. `splitWebSearchCalls` is what turns that
 * one call into the N independent search calls each protocol needs, deciding
 * for each one what it will do and which slice of the original arguments
 * produced it (so a replayed history shows N honest calls rather than N copies
 * of the same one).
 *
 * The shim originates its own searches, so it also knows what it is about to
 * look up before the provider answers: that is the `action` on each plan, and
 * it is what lets a `web_search_call` item announce its query while the search
 * is still in flight.
 */
import { describe, it, expect } from 'bun:test'
import { splitWebSearchCalls } from '../../../../src/data-plane/tools/web-search/plan-operations.ts'

describe('splitWebSearchCalls', () => {
  describe('what each call announces before it runs', () => {
    it('reports a single search query the way the resolved action will', () => {
      const [plan, ...rest] = splitWebSearchCalls({ search_query: [{ q: 'bun 最新版本' }] })
      expect(rest).toEqual([])
      expect(plan!.action).toEqual({ type: 'search', query: 'bun 最新版本', queries: ['bun 最新版本'] })
    })

    it('reports an open as a page fetch', () => {
      const [plan] = splitWebSearchCalls({ open: [{ ref_id: 'https://a.example' }] })
      expect(plan!.action).toEqual({ type: 'open_page', url: 'https://a.example' })
    })

    it('reports a find as an in-page lookup', () => {
      const [plan] = splitWebSearchCalls({ find: [{ ref_id: 'https://a.example', pattern: 'bun' }] })
      expect(plan!.action).toEqual({ type: 'find_in_page', url: 'https://a.example', pattern: 'bun' })
    })

    // A call that will answer with a schema error has no honest preliminary
    // action: announcing one would show the client a search that never runs.
    it('stays silent when the arguments are malformed', () => {
      for (const args of [null, {}]) {
        const plans = splitWebSearchCalls(args)
        expect(plans).toHaveLength(1)
        expect(plans[0]!.action).toBeUndefined()
      }
    })

    it('stays silent on the call carrying an entry that failed to parse', () => {
      const plans = splitWebSearchCalls({ search_query: [{ q: 'a' }, {}] })
      const silent = plans.filter((p) => p.action === undefined)
      expect(silent).toHaveLength(1)
    })
  })

  describe('how one call fans out', () => {
    // Several `search_query` entries stay one call: `{type:'search', queries}`
    // is a protocol-native shape, so batching them loses nothing and costs one
    // fewer output item.
    it('keeps a batch of searches as one call with the joined action', () => {
      const plans = splitWebSearchCalls({ search_query: [{ q: 'a' }, { q: 'b' }] })
      expect(plans).toHaveLength(1)
      expect(plans[0]!.action).toEqual({ type: 'search', query: 'a | b', queries: ['a', 'b'] })
      expect(plans[0]!.arguments).toEqual({ search_query: [{ q: 'a' }, { q: 'b' }] })
    })

    // `open` and `find` actions each carry exactly one url, so they cannot
    // share a call the way queries can — one call each.
    it('gives every open its own call', () => {
      const plans = splitWebSearchCalls({
        open: [{ ref_id: 'https://a.example' }, { ref_id: 'https://b.example' }],
      })
      expect(plans.map((p) => p.action)).toEqual([
        { type: 'open_page', url: 'https://a.example' },
        { type: 'open_page', url: 'https://b.example' },
      ])
      expect(plans.map((p) => p.arguments)).toEqual([
        { open: [{ ref_id: 'https://a.example' }] },
        { open: [{ ref_id: 'https://b.example' }] },
      ])
    })

    // The shape the planner used to reject as "ambiguous" — and the one the
    // tool description invites the model to send.
    it('splits a mix of kinds instead of rejecting it', () => {
      const plans = splitWebSearchCalls({
        search_query: [{ q: 'bun release' }],
        open: [{ ref_id: 'https://bun.sh' }],
        find: [{ ref_id: 'https://bun.sh', pattern: 'install' }],
      })
      expect(plans.map((p) => p.action)).toEqual([
        { type: 'search', query: 'bun release', queries: ['bun release'] },
        { type: 'open_page', url: 'https://bun.sh' },
        { type: 'find_in_page', url: 'https://bun.sh', pattern: 'install' },
      ])
    })

    // Each fanned-out call replays as its own function_call, so its arguments
    // have to name only its own operation. Replaying the whole original object
    // N times would tell the model it asked for everything N times.
    it('gives each call only the arguments that produced it', () => {
      const plans = splitWebSearchCalls({
        search_query: [{ q: 'bun release' }],
        open: [{ ref_id: 'https://bun.sh' }],
      })
      expect(plans.map((p) => p.arguments)).toEqual([
        { search_query: [{ q: 'bun release' }] },
        { open: [{ ref_id: 'https://bun.sh' }] },
      ])
    })

    // One unparseable entry no longer forces the model to resend the good
    // ones: the clean searches run, and the bad entry gets its own call whose
    // result is the error explaining itself.
    it('runs the clean searches and isolates the entry that failed to parse', () => {
      const plans = splitWebSearchCalls({ search_query: [{ q: 'a' }, {}, { q: 'b' }] })
      expect(plans).toHaveLength(2)
      expect(plans[0]!.action).toEqual({ type: 'search', query: 'a | b', queries: ['a', 'b'] })
      expect(plans[1]!.action).toBeUndefined()
    })

    it('gives an unsupported sub-property its own call', () => {
      const plans = splitWebSearchCalls({
        search_query: [{ q: 'a' }],
        click: [{ ref_id: 'https://a.example' }],
      })
      expect(plans).toHaveLength(2)
      expect(plans[1]!.action).toBeUndefined()
      expect(plans[1]!.arguments).toEqual({ click: [{ ref_id: 'https://a.example' }] })
    })

    it('gives a wrong-typed sub-property its own call carrying the raw value', () => {
      const plans = splitWebSearchCalls({ search_query: 'bun' })
      expect(plans).toHaveLength(1)
      expect(plans[0]!.action).toBeUndefined()
      expect(plans[0]!.arguments).toEqual({ search_query: 'bun' })
    })
  })
})
