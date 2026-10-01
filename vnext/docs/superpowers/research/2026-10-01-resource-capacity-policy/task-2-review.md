# Task 2 independent spec and quality review

Reviewed base `9391d2d5` to head `c81e4639`, against the updated task brief and resource-capacity specification. Read-only source review; no source/index/commit changes, network, services, existing test reruns, or full CI. This report is the only written artifact.

## Verdicts

- Spec: **Changes required**. Body admission, immediate fatal latch and propagation satisfy the scoped design, but multi-page provider real-settlement ownership does not.
- Quality: **Changes required** for one Important finding. No Critical or Minor findings.

## Important: multi-page capacity rejection retires the provider before its started sibling fetch settles

Locations: `vnext/packages/gateway/src/data-plane/tools/web-search/providers/jina.ts:283` and `vnext/packages/gateway/src/data-plane/tools/web-search/providers/microsoft-grounding.ts:237`; newly throwing helper catches are respectively `jina.ts:180` and `microsoft-grounding.ts:136`.

Both providers eagerly start one helper per URL and join with `Promise.all`. Previously helper catches converted failures into outcomes. This change correctly rethrows capacity, but consequently the aggregate now rejects on the first overflowing page while another already-started helper can still await its fetch promise. The shared scope is already latched, so downstream delivery can and should fail immediately; that does not retire the outstanding helper.

The concrete outside-diff interface trace is `fetch-page.ts:14-24`: it awaits only the aggregate provider promise and then records usage in finally. `operations.ts:615-620` registers that provider-plus-usage aggregate, not the individual internal page helpers. `execution-scope.ts:77-85` removes registrations on aggregate rejection/completion. Thus, after the other aggregate work and usage settle, the scope can report settled even though the provider's own second fetch/helper promise remains pending. This violates the explicitly retained real-settlement owner contract. It is an observable JavaScript promise ownership issue, not a claim about physical socket cancellation or runtime I/O.

Fix by retaining settlement ownership of all started per-page helper promises through capacity failure, preserving the original fatal reason. Keep immediate ingress.fail/cancel and downstream rejection, existing admitted fanout/order, and usage ownership. For example, the aggregate can join all helper settlements and rethrow the original capacity after they settle, while the existing scope latch already rejects delivery promptly. Add a regression with two real built-in page helpers where the second fetch promise settles only after a test gate; verify scope.settled stays pending and usage remains owned until that gate resolves.

### Independent named-gap probe

Executed from the worktree root using `bun run -` (no files created):

```ts
import { createJinaWebSearchProvider } from './vnext/packages/gateway/src/data-plane/tools/web-search/providers/jina.ts'
import { createMicrosoftGroundingWebSearchProvider } from './vnext/packages/gateway/src/data-plane/tools/web-search/providers/microsoft-grounding.ts'
for (const [name, create] of [['jina', createJinaWebSearchProvider], ['microsoft', createMicrosoftGroundingWebSearchProvider]] as const) {
  let starts = 0, siblingEnded = false, release: (r: Response) => void = () => {}
  const pending = new Promise<Response>(resolve => { release = resolve })
  const controller = new AbortController()
  const impl = create('test', { fetch: (async () => {
    starts++
    if (starts === 1) return new Response('12345')
    const r = await pending
    siblingEnded = true
    return r
  }) as typeof fetch })
  let rejected = false
  const result = impl.fetchPage({
    urls: ['https://a.example', 'https://b.example'], signal: controller.signal,
    ingress: {
      responseBodyBytes: 4,
      assertOpen() { controller.signal.throwIfAborted() },
      debit() {},
      fail(e) { controller.abort(e) },
    },
  }).catch(e => { rejected = true; return e })
  await new Promise(resolve => setTimeout(resolve, 10))
  console.log(JSON.stringify({ name, starts, rejected, siblingEnded, aborted: controller.signal.aborted }))
  release(new Response('{}'))
  await result
}
```

Actual output:

```json
{"name":"jina","starts":2,"rejected":true,"siblingEnded":false,"aborted":true}
{"name":"microsoft","starts":2,"rejected":true,"siblingEnded":false,"aborted":true}
```

A follow-up full-scope stdin probe did not run because the stdin entrypoint could not resolve `@vibe-llm/platform-bun/src/bun-sqlite-repo.ts`. No scope runtime result is claimed from that attempt. Provider early completion is directly reproduced above; its consequence for scope registration follows the inspected interface chain.

## Checked mechanisms and evidence

- `providers/success-body.ts`: before copying, checks the whole chunk against per-response capacity and synchronously debits invocation ingress; retains bounded copied blocks rather than chunk views or a per-network-chunk collection. Exact limit waits for EOF; Content-Length is not authority. Native null body is empty. UTF-8 decoding/JSON parsing follow admitted EOF. Reader catch latches capacity before best-effort cancellation and preserves the thrown error; finally releases the lock. Abort waiters are per active read.
- `capacity.ts`, `types.ts`, `execution-scope.ts`: invocation-owned monotonic counter; no shared provider counter; per-response and aggregate failures close the same scope with the original capacity error; closed gates reject future starts/fallbacks. Task 1 admission remains unchanged.
- `operations.ts`, `key-config.ts`: request capability forwarded for search/pages; capacity escapes error-snippet and configured fallback catches. Existing non-capacity fallback ordering remains intact.
- All six built-in provider source changes checked, including Tavily extraction, Jina reader and inner JSON catch, Microsoft browse/retry, Bing HTML and Copilot JSON/SSE text ingress. Successful read sites use the bounded reader. Remaining full-body calls in Jina and Copilot are non-success error paths, explicitly outside this increment.
- Native Messages catch narrowly rethrows capacity before unavailable conversion. No Messages cumulative invocation budget claim is warranted; the exception is expressly authorized in the updated task brief/spec.
- Reviewed added reader/provider/scope and Chat/Messages/Responses test diffs. Scope settlement tests cover separate search leaves, but not multiple internal page helpers within one built-in fetchPage leaf; hence they miss the finding above.
- Inspected existing evidence logs: focused tests report 206 pass / 0 fail / 590 assertions; scoped gateway typecheck exit 0, purity OK, lint only informational resolver warning. These were not rerun and do not establish that the named settlement gap passes.

## Claim boundaries

Non-awaited underlying stream cancel is explicitly allowed by this specification. `success-body.ts:24-31,40-44,67-75` observes cancel rejection and releases the reader lock; a standard stream cancel closes pending read requests independently of an underlying cancel promise. That is not independently reported as a defect. No claim is made that abort proves physical I/O completion. The finding instead concerns actual per-page fetch/helper promises started by the provider and left outside real-settlement ownership after Promise.all rejects.

Defaults are engineering policy, not measured CFW-safe limits. No whole-isolate heap, parse expansion, physical network cancellation, workerd performance, deployment or full protocol-owner HTTP end-to-end qualification follows from this review. Native Messages/Alpha local have standalone per-response protection only, without a new invocation aggregate budget. Task 3 retention and Task 4 diagnostics remain outside this Task 2 review. No dependencies, migrations, environment configuration, new any/suppressions/non-null assertions, or protected overlay edits were found in the scoped change.
