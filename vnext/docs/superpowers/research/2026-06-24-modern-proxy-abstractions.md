# Modern Proxy/Gateway Framework Abstractions — Code-Level Research

**Date:** 2026-06-24
**Scope:** Cloudflare Pingora, Tower (linkerd2-proxy), Caddy, Traefik, Tyk, Sozu, Envoy generic_proxy, HAProxy SPOE
**Approach:** Read the actual trait/interface declarations in source, not just docs.

---

## Project 1: Cloudflare Pingora

- **Stack:** Rust, async (Tokio). `pingora-proxy` crate.
- **Core trait/interface:** `ProxyHttp` (in `pingora-proxy/src/proxy_trait.rs`). One associated type `CTX` (per-request state) and **~30 lifecycle methods**, only two required: `new_ctx() -> Self::CTX` and `async fn upstream_peer(&self, session, ctx) -> Result<Box<HttpPeer>>`. The rest are default-implemented hooks.
- **Phases (canonical order):**
  1. `early_request_filter` → `request_filter` (returns `bool` = "I wrote the response, stop") → `request_body_filter` (per-chunk)
  2. `request_cache_filter` → `cache_key_callback` → `cache_hit_filter`
  3. `proxy_upstream_filter` → `upstream_peer` → `connected_to_upstream`
  4. `upstream_request_filter` → `upstream_response_filter` / `_body_filter` / `_trailer_filter`
  5. `response_cache_filter` → `response_filter` / `_body_filter` / `_trailer_filter`
  6. `logging` (always) → `persist_connection_context` + `on_connection_reuse` (HTTP/1 keepalive only)
  - Error edges: `fail_to_connect` (retryable), `error_while_proxy`, `fail_to_proxy` (terminal), `should_serve_stale`.
- **Composition:** No middleware chain. One trait impl IS the proxy; "filters" are method overrides on a single object. Built-in "downstream modules" (`init_downstream_modules`) are a parallel mechanism for things like compression.
- **Upstream:** `HttpPeer` (address + TLS + SNI + ALPN) returned per-request from `upstream_peer`. No cluster abstraction in the trait — backend selection is user code.
- **Config plane:** Pure Rust. No JSON/YAML hot-reload; graceful restart via SO_REUSEPORT + parent-child handoff.
- **Extension API:** Implement `ProxyHttp` for your struct; override phases you care about. Compiler enforces signatures.
- **Domain-neutral vs HTTP-specific:** Trait is HTTP-specific (headers/trailers/cache/range). `pingora-core` underneath has protocol-neutral `Server`/`Service` traits; ProxyHttp is the HTTP specialization.
- **Notable:**
  - **`CTX` as associated type** — typed per-request state with no `Any` downcasts.
  - **`Result<bool>` return** where `true` means "response already produced, short-circuit." Cleaner than "did you write to the ResponseWriter?"
  - **Cache is first-class in the trait** — reflects CF's actual workload but couples the abstraction.

---

## Project 2: Tower (and linkerd2-proxy)

- **Stack:** Rust, async. `tower-service` + `tower-layer` crates.
- **Core trait/interface:**
  ```rust
  trait Service<Request> {
      type Response; type Error;
      type Future: Future<Output = Result<Self::Response, Self::Error>>;
      fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>>;
      fn call(&mut self, req: Request) -> Self::Future;
  }
  trait Layer<S> { type Service; fn layer(&self, inner: S) -> Self::Service; }
  ```
- **Phases:** None as a concept. A "phase" is just another `Service` in the stack — there's no enumerated lifecycle.
- **Composition:** `Layer<S>` wraps `Service<Request>`. Stacks are built with `ServiceBuilder` (linkerd2-proxy uses its own `svc::Stack<S>::push(layer)` fluent builder). Each layer is a decorator producing the next-inner Service. The order is explicit and homogeneous: every middleware is just a Service-of-Service.
- **Upstream:** Not in the trait. linkerd2-proxy models backends via discovery layers that produce `NewService<Target> -> Service<Request>` — the target type (e.g. `Logical`, `Concrete`, `Endpoint`) flows through the stack and a `MakeService` resolves it. Load balancing is `p2c::layer()` over a discovery stream.
- **Config plane:** linkerd2-proxy reads xDS-style discovery from the control plane; the proxy's Rust code is the "config" for how layers compose.
- **Extension API:** Implement `Service<Req>` for your struct, or implement `Layer<S>` to wrap arbitrary inner services. Many existing crates compose for free (timeout, retry, balance, buffer, rate-limit, load-shed).
- **Domain-neutral vs HTTP-specific:** **Fully domain-neutral.** `Request` is generic; the same stack runs HTTP, gRPC, TCP, Thrift. linkerd2-proxy has separate `http` and `tcp` stacks built from the same primitives.
- **Notable:**
  - **`poll_ready` for backpressure** is the standout: capacity is part of the type, not an afterthought. Lets load-shed/retry/buffer compose cleanly.
  - **Layer is generic over `S`** so middleware authors don't bind to a specific request shape. Same `TimeoutLayer` works for HTTP, gRPC, custom protocols.
  - **`NewService<Target>` pattern** (a Service-of-Service for per-target stacks) is the cleanest answer to "how do I have one config but many backends" — beats most "cluster" abstractions.

---

## Project 3: Caddy

- **Stack:** Go (net/http).
- **Core trait/interface:** Two levels.
  ```go
  type Module interface { CaddyModule() ModuleInfo }
  type ModuleInfo struct { ID ModuleID; New func() Module }
  type Handler interface { ServeHTTP(http.ResponseWriter, *http.Request) error }
  type MiddlewareHandler interface {
      ServeHTTP(http.ResponseWriter, *http.Request, Handler) error
  }
  ```
  Optional sub-interfaces: `Provisioner`, `Validator`, `CleanerUpper`.
- **Phases:** Go around-middleware (`next` is passed in). No enumerated phases. Module lifecycle: provision → validate → run → cleanup.
- **Composition:** Around-middleware via `next`. Routes group `RequestMatcher` predicates with `MiddlewareHandler` slices; matching routes fold handlers into one chain ending at a terminal `Handler`.
- **Upstream:** `reverseproxy.Upstream` + `UpstreamSource` interface for dynamic discovery. Pools live inside the reverseproxy module.
- **Config plane:** JSON is canonical; Caddyfile compiles to JSON. **Admin REST API** (`/load`, `/config/...`, `/id/...`) for runtime config swap with diff-aware graceful reload. Every change is an atomic swap of the whole tree.
- **Extension API:** Implement `Module`, return `ModuleInfo{ID, New}`, call `caddy.RegisterModule(yours)` in `init()`. ID is namespaced (e.g. `http.handlers.rate_limit`); JSON config locates your module by position in the namespace tree.
- **Domain-neutral vs HTTP-specific:** Module system is fully neutral (powers storage, DNS, TLS, logging too). HTTP handler/middleware lives only in `modules/caddyhttp`.
- **Notable:**
  - **Module ID namespace as the extension contract.** Adding a feature = register `http.handlers.myfeature`; config refers to it by ID. No registration code in the consumer.
  - **JSON-config-as-truth** drives admin API, Caddyfile, k8s operator, and tests.
  - **Optional sub-interfaces via type assertion** — opt-in lifecycle is much less boilerplate than mandatory full lifecycle.

---

## Project 4: Traefik

- **Stack:** Go.
- **Core trait/interface:**
  ```go
  type Provider interface {
      Provide(configurationChan chan<- dynamic.Message, pool *safe.Pool) error
      Init() error
  }
  ```
  Handler chain reuses `http.Handler` via Alice-style composition.
- **Phases:** Standard Go around-middleware. **EntryPoint → Router → Middleware chain → Service → LoadBalancer → Server** — each named and addressable in dynamic config.
- **Composition:** Middlewares declared in dynamic config, attached to routers; built into `http.Handler` chains at config-apply time.
- **Upstream:** `Service` (logical name) holds a `LoadBalancer` of `Servers` (URL endpoints). Router/Service split enforced: routers match, services dispatch.
- **Config plane:** **Provider abstraction is centerpiece.** Static config bootstraps; dynamic config arrives over a channel from any provider (Docker, K8s CRD/Ingress, Consul, file-watch, ECS, Nomad…). Aggregator merges streams and rebuilds the in-memory router atomically.
- **Extension API:** Implement `Provider` for new infra sources. Middlewares are HTTP handler wrappers registered by name (built-ins + Yaegi-based in-process Go plugins).
- **Domain-neutral vs HTTP-specific:** Provider abstraction is neutral. Routing has separate stacks for HTTP, TCP, UDP — each mirrors the Router/Service split.
- **Notable:**
  - **Streaming `dynamic.Message` over a channel** as the provider contract — providers become trivially composable and testable.
  - **Router/Service split** as named first-class entities — enables "same backend, different match rules" without duplication.
  - **Provider aggregator with last-writer-wins merge** keeps the core ignorant of where config came from.

---

## Project 5: Tyk Gateway

- **Stack:** Go (net/http + Alice chain constructor).
- **Core trait/interface:** `TykMiddleware` — central method is `ProcessRequest(w, r, conf) (error, int)`. Sub-methods: `EnabledForSpec()`, `Init()`, `Config()`, `Unload()`, `Name()`. Response side: `TykResponseHandler`.
- **Phases:** pre → auth → post-auth → post → proxy → response, each a slot populated by `mwAppendEnabled()`.
- **Composition:** Alice chain; `createMiddleware(mw)` wraps each into a standard `http.Handler` adding tracing/metrics.
- **Upstream:** `APISpec` holds upstream URL + LB targets; per-API config passed through chain.
- **Config plane:** API definitions in JSON (file, REST API, dashboard RPC). Hot-reload via SIGUSR2 or REST. Plugin loaders for gRPC, JS, Lua, Python, native Go.
- **Extension API:** Implement `TykMiddleware`, return `(error, status)`. Or gRPC plugin server speaking the dispatcher proto.
- **Domain-neutral vs HTTP-specific:** Tightly HTTP-bound (`ProcessRequest` takes `http.ResponseWriter`).
- **Notable:**
  - **`(error, statusCode)` return** instead of write-or-don't-call-next — explicit short-circuit signal.
  - **`EnabledForSpec()` self-gate** so the chain builder doesn't need plugin semantics.
  - **`TraceMiddleware` decorator** demonstrates cross-cutting via composition, not intrusive hooks.

---

## Project 6: Sozu

- **Stack:** Rust, raw mio (no async runtime).
- **Core trait/interface:** `ProxySession{protocol, ready, timeout, cluster_id}` for per-connection state machines; `L7Proxy{register_socket, add_session, backends, clusters}` for the listener.
- **Phases:** None — connection-state-machine driven. `ready()` is called on mio IO events and the session walks its protocol state internally.
- **Composition:** None at filter level. Sozu prioritizes zero-cost over extensibility.
- **Upstream:** `Cluster` + `BackendMap` shared via `Rc<RefCell<>>`; explicit pool with health checks.
- **Config plane:** **Channel-based incremental updates.** Workers receive `WorkerRequest{RequestType::{AddCluster, AddHttpFrontend, AddBackend, ...}}` over a unix-socket queue, respond with `WorkerResponse`. No file reload — every change is a typed diff.
- **Extension API:** Limited — protocols baked in via `ProxySession` impls.
- **Domain-neutral vs HTTP-specific:** `ProxySession` is protocol-neutral; `L7Proxy` is L7-flavored.
- **Notable:**
  - **Typed incremental diffs** (AddCluster vs AddBackend) beat "send whole config tree."
  - **Hot reload by replaying message log** to a new worker.
  - Terse trait surface vs Pingora's 30 methods reflects a "we own the proxy, you own the config" stance.

---

## Project 7: Envoy generic_proxy filter

- **Stack:** C++. Network filter inside Envoy.
- **Core trait/interface:** Four pluggable interfaces.
  ```cpp
  class ServerCodec {
      virtual void setCodecCallbacks(ServerCodecCallbacks&) PURE;
      virtual void decode(Buffer::Instance&, bool end_stream) PURE;
      virtual EncodingResult encode(const StreamFrame&, EncodingContext&) PURE;
      virtual ResponseHeaderFramePtr respond(Status, absl::string_view,
                                             const RequestHeaderFrame&) PURE;
  };
  class ClientCodec { /* mirror for upstream */ };
  class DecoderFilter {
      virtual HeaderFilterStatus decodeHeaderFrame(RequestHeaderFrame&) PURE;
      virtual CommonFilterStatus decodeCommonFrame(RequestCommonFrame&) PURE;
  };
  class EncoderFilter { /* mirror */ };
  class StreamFilter : public DecoderFilter, public EncoderFilter {};
  ```
- **Phases:** Decode (request) → Route → Router (upstream) → Encode (response). Statuses `Continue`/`StopIteration` control flow exactly like HCM.
- **Composition:** Filter chain configured in YAML; same pattern as HTTP connection manager but over the generic frame abstraction.
- **Upstream:** Reuses Envoy's cluster manager — protocol-neutral upstream selection.
- **Config plane:** xDS (same as Envoy core).
- **Extension API:** Write a `CodecFactoryConfig` + `ServerCodec`/`ClientCodec` pair to teach generic_proxy a new wire protocol (Dubbo, Kafka, Redis, MQTT, custom RPC). Write `DecoderFilter`/`EncoderFilter` to add filter logic that works across ALL such protocols.
- **Domain-neutral vs HTTP-specific:** **This is the headline.** The whole point is to **generalize HCM's "headers / data / trailers / route / cluster / filter" model to any L7 protocol** by abstracting the wire format into a Codec and the message into `StreamFrame` (HeaderFrame + CommonFrame).
- **Notable:**
  - **Codec/Filter split** — wire format and policy logic are independently pluggable. A rate-limit filter works for HTTP, Kafka, Dubbo without rewriting.
  - **Frame as the universal IR** (header frame + N common frames + optional trailer) — handles streaming and one-shot uniformly.
  - **Mirror server/client codec pair** acknowledges that downstream-decode and upstream-encode are different operations even on "the same" protocol.

---

## Project 8: HAProxy SPOE

- **Stack:** C (HAProxy); agent can be any language.
- **Core trait/interface:** Not a code trait — a **wire protocol** (SPOP) over TCP.
- **Phases:** HAProxy emits NOTIFY bound to lifecycle events (`on http-request`); agent replies ACK with actions.
- **Composition:** Each agent backend is one SPOE filter instance attached to a frontend; filters chain in config order.
- **Upstream:** Agents are normal HAProxy backends — load-balanced, health-checked.
- **Config plane:** SIGUSR2 reload; SPOE config in a sidecar file.
- **Extension API:** Implement an SPOA in any language. Frames: HAPROXY-HELLO ↔ AGENT-HELLO, NOTIFY → ACK with `set-var`/`unset-var` actions.
- **Domain-neutral vs HTTP-specific:** Protocol-neutral.
- **Notable:**
  - **Variables-as-return-channel** — agent sets variables HAProxy reads via ACLs/headers. Decouples sandboxing from filter semantics.
  - **Framed binary protocol with versioned HELLO** — capability negotiation built in.
  - **Out-of-process** lets non-C languages add filters without bloating the fast path.

---

## Synthesis

### Trait/interface shapes converging across projects

Three families dominate, more compatible than they look:

1. **Service-style:** `async fn handle(req) -> Result<resp>` with **explicit readiness/backpressure**. Tower's `Service<Req>` + `Layer<S>` is canonical. Domain-neutral by construction.
2. **Phase-callback style:** one big trait with named lifecycle hooks. Pingora's `ProxyHttp` is the modern exemplar (2 required, ~28 default); Envoy HCM is the C++ ancestor. Protocol-family-specific; high signal-to-noise.
3. **Around-middleware style:** `func(w, r, next)`. Go-idiomatic; used by Caddy, Tyk, Traefik. Low cognitive load; weakest type safety around "did you call next or write a response."

**No convergence on phase names.** Pingora has 30, Tyk has 4 slots, Caddy has none. What does converge: every framework distinguishes request/response sides, has per-chunk body filters, has a terminal "produce response" decision, and has a logging hook that always runs.

**Per-request typed context is converging:** Pingora `CTX` associated type, Tower request-extensions, Envoy `StreamInfo`, Caddy per-request map. Pingora's typed-no-`Any` design is technically cleanest.

### Where projects diverge on extension API

- **Tower / linkerd2-proxy:** layered Service stack. Pro: composes across protocols. Con: notorious type errors during stack construction.
- **Caddy / Envoy generic_proxy:** module/extension registration with ID namespacing + JSON/proto config. Pro: same module is reachable from CLI, API, and tests by ID. Con: your code is "an entry in a registry."
- **Pingora:** override methods on a trait impl. Pro: zero ceremony, IDE autocompletes phases. Con: hard to share logic across deployments without orthogonal helpers.
- **Tyk / Traefik:** named middlewares attached to routes from dynamic config. Pro: ops-friendly. Con: every middleware is HTTP-bound.
- **SPOE:** out-of-process via wire protocol. Pro: language-neutral, sandboxed. Con: latency + serialization per call.

### What a 2026-era gateway framework abstraction MUST have

1. **A single core trait generic over the request type.** Tower's `Service<Req>` proves it works for HTTP, gRPC, TCP. Pingora proves a non-generic trait paints you into HTTP.
2. **Typed per-request context** (Pingora `CTX`), not `HashMap<String, Any>`.
3. **Explicit "I wrote the response" signal** as a return type — `Result<bool>`, `Status::Continue/StopIteration`, a `Response` variant. Don't infer from side effects.
4. **Async backpressure/readiness** in the type system (Tower `poll_ready`). Load shedding, retry, buffering, queue-bounded resilience all need this.
5. **Codec/filter split** for protocols beyond HTTP (Envoy generic_proxy). Wire format and policy independently pluggable; one rate-limit filter for HTTP and Kafka.
6. **Streaming config plane.** A `chan<- ConfigMessage` (Traefik) or unix-socket protocol (Sozu) beats "watch a file." Providers compose; file-watch is just one provider.
7. **Lifecycle as optional sub-interfaces** (Caddy `Provisioner`/`Validator`/`CleanerUpper` via type assertion) rather than mandatory full lifecycle on every plugin.
8. **Module ID namespacing** so one registry powers code, config, and admin API.

### What it should DELIBERATELY avoid

- **30-method God traits even with defaults** (Pingora). Easy today, frozen tomorrow. Split decode/encode/lifecycle into focused sub-traits (Envoy generic_proxy) instead.
- **Cache as a first-class hook in the core trait** (Pingora). Most gateways aren't CDNs. Cache is a filter or sub-module that opts in.
- **Untyped per-request bag** (`map[string]interface{}`, `HashMap<String, Box<dyn Any>>`). Every project that started there regrets it.
- **Synchronous middleware in an async core.** Forces every author to think about blocking.
- **One-shot config reload by file** (HAProxy SPOE). Incremental diff messages (Sozu) and atomic JSON swap (Caddy) are both better.
- **Stack composition with five-line where-clauses** (Tower in practice). Model is right but ergonomics need a builder. linkerd2-proxy's `svc::Stack::push(layer)` is the working compromise.
- **Side-effects-as-control-flow** (write-or-don't-call-next). Always return an explicit decision.
- **Coupling the extension API to the request type** (Tyk's `http.ResponseWriter`). The moment you want a non-HTTP listener, you're painted in.

**One-line takeaway:** the winning abstraction is `Service<Req>` + `Layer<S>` for composition, with Pingora-style **typed CTX** for per-request state and Envoy generic_proxy-style **codec/filter split** when spanning protocols. Config plane is a separate concern — adopt Traefik's provider channel or Sozu's incremental message queue, not "reread file on SIGHUP."
