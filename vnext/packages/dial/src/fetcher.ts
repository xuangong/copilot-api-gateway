/**
 * Fallback-aware egress dialer.
 *
 * Builds a `Fetcher` that walks an upstream's ordered proxy fallback list,
 * shedding proxies that are in active backoff and falling back to built-in
 * transports (`direct_connect` raw socket, `direct_fetch` runtime fetch).
 *
 * Ported from copilot-gateway/packages/gateway/src/dial/fetcher.ts.
 */
import { createReplayableRequest, type ReplayableRequest } from './replayable-request.ts'
import type { ProxyEntry } from './proxy-catalog.ts'
import { isAbortError, type HttpRequest } from '@vibe-core/http'
import {
  ProxyDialError,
  type ProxyConfig,
  type ProxyRequestTarget,
  type RunDirectConnectRequestOptions,
  type RunProxiedRequestOptions,
  type SocketDial,
} from '@vibe-core/proxy'
import {
  DIRECT_CONNECT_ID,
  DIRECT_FETCH_ID,
  entryMatchesColo,
  isDirectFallbackId,
  type ProxyBackoffRepo,
  type ProxyFallbackEntry,
} from '@vibe-core/proxy-repo'
import type { Fetcher } from '@vibe-core/upstream'

export interface CreateFetcherInput {
  proxyBackoffs: Pick<ProxyBackoffRepo, 'listForUpstream' | 'recordDialFailure' | 'recordDialSuccess'>
  upstreamId: string
  fallbackList: readonly ProxyFallbackEntry[]
  proxyById: Map<string, ProxyEntry>
  /** Location tag the request landed in; applies each entry's `colos` whitelist. */
  runtimeLocation: string
  // Injected so the fetcher stays runtime-agnostic — the composition root
  // chooses the concrete dial/fetch implementations.
  runProxied: (
    config: ProxyConfig,
    target: ProxyRequestTarget,
    request: HttpRequest,
    options: RunProxiedRequestOptions,
  ) => Promise<Response>
  runDirectFetch: (url: string, init: RequestInit) => Promise<Response>
  runDirectConnect: (
    target: ProxyRequestTarget,
    request: HttpRequest,
    options: RunDirectConnectRequestOptions,
  ) => Promise<Response>
  /**
   * Lazily evaluated so direct-fetch-only call sites can run without an
   * installed SocketDial impl.
   */
  socketDial: () => SocketDial
}

// Two-pass dial strategy. The first pass walks the fallback list skipping any
// entry whose (proxy, upstream) backoff row is still active, so a flaky proxy
// gets shed in steady state. The second pass walks only the entries the first
// pass skipped — that's how we both kick the recovery schedule and keep
// serving when every proxy is in cooldown. Entries that already failed on
// pass 1 are NOT retried; doing so would double the backoff fail-count for
// every real failure and warp the geometric schedule.
export const createFetcher = (input: CreateFetcherInput): Fetcher => {
  // An unset policy means direct egress, and direct egress defaults to raw TCP
  // rather than the runtime's `fetch`, because both runtimes' `fetch` abandon a
  // response whose body goes quiet for long enough. Cloudflare's Proxy Read
  // Timeout bounds the gap between two consecutive reads of the upstream
  // response at 120s; Node's fetch is undici, whose `bodyTimeout` defaults to
  // 300s. Either one kills a stream that has already returned HTTP 200 and then
  // thinks, and neither limit is reachable from here. A raw socket has no such
  // bound. `direct_fetch` keeps the runtime connection pool and HTTP/2, so it
  // stays selectable, but an operator has to ask for it.
  //
  // The colo filter precedes the implicit direct-connect collapse so a
  // fully-excluded list behaves like an empty list rather than throwing
  // because pass 1 had no candidates.
  const matched = input.fallbackList.filter((entry) =>
    entryMatchesColo(entry, input.runtimeLocation),
  )
  const list = matched.length > 0 ? matched.map((entry) => entry.id) : [DIRECT_CONNECT_ID]
  // If direct-fetch precedes any materialized transport, runtime fetch may take
  // ownership of `init.body` and consume its underlying stream/Blob. Buffer the
  // body up-front so a runtime that re-streams a Blob can't strand a later
  // proxy attempt with empty bytes. The direct-fetch-only fast path keeps the
  // runtime's native body handling intact — FormData, Blob, etc. stay unbuffered.
  const hasMaterializedTransport = list.some((id) => id !== DIRECT_FETCH_ID)
  const hasDirectFetch = list.includes(DIRECT_FETCH_ID)
  const directFetchBeforeMaterialized =
    hasMaterializedTransport && hasDirectFetch && list.indexOf(DIRECT_FETCH_ID) < list.length - 1

  return (url, init) => {
    // Reject streaming bodies upfront whenever any materialized entry is in
    // play. The two-pass dial can replay a request and a stream is single-shot.
    if (hasMaterializedTransport && init.body instanceof ReadableStream) {
      return Promise.reject(
        new Error(
          'streaming request bodies are not replayable through direct-connect or proxy transports',
        ),
      )
    }
    return runFallbacks(
      input,
      list,
      url,
      createReplayableRequest(url, init),
      directFetchBeforeMaterialized,
    )
  }
}

const runFallbacks = async (
  input: CreateFetcherInput,
  list: readonly string[],
  url: string,
  request: ReplayableRequest,
  directFetchBeforeMaterialized: boolean,
): Promise<Response> => {
  // A direct-fetch attempt before a materialized transport can consume
  // Blob/FormData bodies. Build the replayable byte form first so every later
  // attempt observes one body.
  if (directFetchBeforeMaterialized) await request.materialized()
  const errors: unknown[] = []

  // Backoff rows only ever exist for operator-managed proxies, so a list made
  // entirely of built-in transports has nothing to look up. Skipping the read
  // keeps the direct-only path — what an unset policy resolves to — free of a
  // per-request store round-trip.
  const skip = new Set<string>()
  if (list.some((id) => !isDirectFallbackId(id))) {
    const active = await input.proxyBackoffs.listForUpstream(input.upstreamId)
    const now = Math.floor(Date.now() / 1000)
    for (const b of active) if (b.expiresAt > now) skip.add(b.proxyId)
  }

  const triedThisCall = new Set<string>()
  for (const id of list) {
    if (skip.has(id)) continue
    triedThisCall.add(id)
    const result = await tryOne(id, input, request, url, errors)
    if (result) return result
  }

  for (const id of list) {
    if (triedThisCall.has(id)) continue
    const result = await tryOne(id, input, request, url, errors)
    if (result) return result
  }

  // A single fallback entry that failed once produces just one error — surface
  // it directly so callers don't see a meaningless AggregateError wrapper.
  if (errors.length === 1) throw errors[0]
  throw new AggregateError(errors, 'all proxies failed at the dial layer')
}

const tryOne = async (
  id: string,
  input: CreateFetcherInput,
  request: ReplayableRequest,
  url: string,
  errors: unknown[],
): Promise<Response | null> => {
  try {
    if (id === DIRECT_FETCH_ID) {
      // Direct egress is the runtime's fetch — it never raises ProxyDialError,
      // so we don't touch the backoff table for this entry.
      return await input.runDirectFetch(url, request.fetchInit())
    }
    if (id === DIRECT_CONNECT_ID) {
      const materialized = await request.materialized()
      return await input.runDirectConnect(materialized.target, materialized.request, {
        socketDial: input.socketDial(),
        signal: request.signal,
      })
    }
    const config = input.proxyById.get(id)
    if (!config) {
      // The catalog was loaded once at the top of the request, but an admin can
      // delete a row mid-flight. Treat the missing id as a dial-shaped failure
      // for THIS entry so the chain advances instead of killing the whole call.
      // No backoff write — the row is gone.
      errors.push(new ProxyDialError(`unknown proxy id in fallback list: ${id}`, 'config'))
      return null
    }
    const materialized = await request.materialized()
    // An explicit request signal joins the dialer's timeout controller so its
    // caller can stop an in-flight handshake before the per-proxy deadline.
    const options: RunProxiedRequestOptions = {
      socketDial: input.socketDial(),
      signal: request.signal,
    }
    if (config.dialTimeoutMs !== null) options.dialTimeoutMs = config.dialTimeoutMs
    const response = await input.runProxied(
      config.config,
      materialized.target,
      materialized.request,
      options,
    )
    // A successful dial after a previous failure must clear the backoff so the
    // next failure restarts at n=1 instead of resuming the geometric schedule.
    // A transient bookkeeping rejection must not discard a healthy Response.
    try {
      await input.proxyBackoffs.recordDialSuccess(id, input.upstreamId)
    } catch (recordErr) {
      console.warn(`failed to clear proxy backoff for ${id}/${input.upstreamId}:`, recordErr)
    }
    return response
  } catch (err) {
    // Explicit cancellation propagates immediately so the chain does not
    // continue against later fallback entries.
    if (isAbortError(err)) throw err

    if (id === DIRECT_FETCH_ID) {
      // Direct egress fails for the same dial-shaped reasons a proxy can (TCP
      // refused, SNI reset, DNS, connect timeout). Runtime fetch surfaces those
      // as plain Errors / TypeErrors, but for fallback semantics they ARE dial
      // failures — request bytes never reached an upstream. Advance like we
      // would for a proxy, minus the backoff bookkeeping.
      errors.push(err)
      return null
    }
    if (id === DIRECT_CONNECT_ID) {
      if (err instanceof ProxyDialError) {
        errors.push(err)
        return null
      }
      throw err
    }
    if (err instanceof ProxyDialError) {
      errors.push(err)
      // Tag the persisted message with the dial stage so a dashboard reader can
      // tell a tcp-connect refusal from an inner-tls cert mismatch. A transient
      // backoff-store failure must not shadow the real dial error.
      try {
        await input.proxyBackoffs.recordDialFailure(
          id,
          input.upstreamId,
          `[${err.stage}] ${err.message}`,
        )
      } catch (recordErr) {
        console.warn(`failed to persist proxy backoff for ${id}/${input.upstreamId}:`, recordErr)
      }
      return null
    }
    throw err
  }
}
