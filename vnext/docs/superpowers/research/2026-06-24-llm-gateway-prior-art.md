# LLM Gateway Prior Art Research

Date: 2026-06-24
Purpose: extract concrete abstraction-layer decisions from 8 LLM gateway projects to inform vNext framework design.

---

## Project 1: LiteLLM Proxy (BerriAI/litellm)

- **Stack**: Python 3.x, FastAPI; sync + async sides; ~100 providers.
- **Core abstractions**:
  - `BaseConfig` (`litellm/llms/base_llm/chat/transformation.py`) — abstract per-provider config; required methods: `get_supported_openai_params`, `map_openai_params`, `validate_environment`, `transform_request`, `transform_response`, `get_error_class`, optional `async_transform_request`. Streaming via `BaseModelResponseIterator` returned from `get_model_response_iterator()`.
  - `Router` (`litellm/router.py`) — owns `model_list` (deployments = `{model_name, litellm_params, tpm_limit, rpm_limit}`), routing groups, cooldown cache, dual cache (Redis + memory), retry/fallback engine.
  - `route_llm_request.route_request()` — dispatcher: bypass-on-explicit-key → user_config router → router → direct `litellm.acompletion`.
  - Per-route file structure: `litellm/llms/<provider>/<endpoint>/<provider>_transformation.py`. Inheritance hierarchy is real: `OpenAIGPTConfig(BaseLLMModelInfo, BaseConfig) → OpenAIChatCompletionStreamingHandler(BaseModelResponseIterator)`.
- **Request lifecycle**: implicit, function-call chain — auth/middleware (FastAPI) → `route_request` → router selects deployment → strategy selector (`LeastBusy`, `LowestTPM`, `LowestLatency`, `LowestCost`, `simple-shuffle`) → `validate_environment` → `transform_request` → HTTP → `transform_response` → callbacks/hooks (`custom_hooks/`, `hooks/`) → response. No named phases — phases are method names on `BaseConfig`.
- **Extension model**: subclass `BaseConfig` in `litellm/llms/<provider>/chat/transformation.py`, override 6 methods, register in `litellm.utils.get_llm_provider`. Provider parameters are declared as a Python set in `get_supported_openai_params`.
- **Streaming**: pull-based iterator. `get_model_response_iterator()` returns a `BaseModelResponseIterator` subclass; `chunk_parser()` converts provider SSE → normalized `ModelResponse` chunk. `CustomStreamWrapper` wraps the iterator; supports `MidStreamFallbackError` that re-enters Router fallback chain mid-stream.
- **Cross-protocol translation**: source format is fixed (OpenAI chat-completions). Provider transforms are unidirectional OpenAI↔native. Anthropic-style `/v1/messages` is handled by a separate `anthropic_messages/` endpoint module that re-uses the OpenAI normalization internally. Not a Cartesian matrix.
- **Domain-neutral vs LLM-specific**: ~5% neutral (FastAPI auth, rate limit middleware). 95% LLM-specific — `ModelResponse`, `tpm_limit`, `context_window_fallbacks`, `content_policy_fallbacks`, token-aware cooldowns.
- **Notable**: (1) Three named fallback families (generic, context-window, content-policy) — semantic, not just retry. (2) Silent shadow-deployment (`silent_model`) mirrors traffic for A/B. (3) Pre-call checks filter deployments by context window before strategy runs.

## Project 2: Portkey AI Gateway (Portkey-AI/gateway)

- **Stack**: TypeScript, Hono (edge-runnable), Cloudflare Workers compatible. Our closest analog.
- **Core abstractions** (file refs from `src/`):
  - `ProviderConfig` (`src/providers/types.ts`) — `{ [paramName]: ParameterConfig | ParameterConfig[] }` where `ParameterConfig = { param, default, min, max, required, transform(params, providerOptions) }`. **Declarative param mapping** instead of imperative transform methods.
  - `RequestContext` + `ProviderContext` + `HookSpan` (`src/handlers/handlerUtils.ts`) — three context objects: request-scoped state, provider-scoped (auth/URL/transformation), and hook execution span.
  - Services (injected, OO): `CacheService`, `HooksService`, `LogsService`, `ResponseService`, `PreRequestValidatorService`, `ConditionalRouter`.
  - Provider folder structure: each provider in `src/providers/<name>/` exposes per-endpoint files: `chatComplete.ts`, `complete.ts`, `embed.ts`, `createSpeech.ts`, `createTranscription.ts`, `imageGenerate.ts`, `createBatch.ts`, `uploadFile.ts`, `createFinetune.ts`, plus `api.ts` (URL/header builder) and `index.ts` (registry).
  - `Targets` + `Options` + `StrategyModes` (FALLBACK, LOADBALANCE, CONDITIONAL, SINGLE) — composable routing tree.
- **Request lifecycle**: explicit named phases, function-named:
  1. `beforeRequestHookHandler` (can deny → HTTP 446)
  2. `constructRequest` (`constructRequestHeaders` + `constructRequestBody`)
  3. `CacheService` lookup
  4. `PreRequestValidatorService` (budget/quota)
  5. `retryRequest` (provider call)
  6. `responseHandler` (transform)
  7. `afterRequestHookHandler` (can deny / transform → HTTP 246 for partial-fail)
  8. `LogsService.record`
- **Extension model**: drop a folder under `src/providers/<name>/`, export a `ProviderConfigs` object (declarative param maps + `api`, `responseTransforms`), register in `src/providers/index.ts`. No subclassing required — config-only providers possible.
- **Streaming**: push-based `TransformStream`. `handleStreamingMode()` (`src/handlers/streamHandler.ts`) wraps response body in a `TransformStream` piping chunks through provider transformers. `readStream()` buffers + splits on provider `splitPattern` (Bedrock has binary-frame variant `readAWSStream`). Telemetry sits AFTER the stream transformer (hooks can prepend SSE events via `shouldSendHookResultChunk`).
- **Cross-protocol translation**: `transformToProviderRequest` (`src/services/transformToProviderRequest.ts`) drives the declarative param map. Source format is normalized OpenAI-shape; target is whatever the provider's `ProviderConfig` declares. Single-direction translation. Responses translated back via `responseTransforms`. NOT a Cartesian matrix.
- **Domain-neutral vs LLM-specific**: ~30% neutral — Hono routing, `RequestContext`, hook lifecycle, cache/log services are protocol-agnostic. 70% LLM-specific — `Targets`/strategy modes, guardrails ("verdict" results), `realtimeLlmEventParser`, hook span carries `request_type` + provider explicitly.
- **Notable**: (1) Heavy `requestValidator` middleware focuses on **SSRF defense** (blocks cloud metadata IPs, IPv6-mapped IPv4, internal TLDs) — gateways are routinely targeted. (2) Hook results returned via HTTP **status codes 246 (soft-fail) and 446 (deny)** — encodes hook state in transport. (3) Provider params declared as data, not code — adds provider often = pure data file. (4) ConditionalRouter routes by metadata/params, not just header.

## Project 3: Cloudflare AI Gateway

- **Stack**: Proprietary; runs on Cloudflare Workers. Public docs only.
- **Core abstractions** (inferred from docs):
  - **Universal Endpoint**: one URL, request body is an **array of provider attempts** (each `{provider, endpoint, headers, query}`) — gateway tries them in order. This makes fallback request-level data, not server config.
  - "Logs" and "Analytics" as first-class objects.
  - **Custom Costs**, **Spend Limits**, **Rate Limits** (sliding/fixed window) as policies.
  - **Guardrails** and **DLP** as moderation layers.
- **Request lifecycle**: client → universal endpoint → ordered provider list → caching (90% latency reduction claim) → rate-limit → guardrails → provider HTTP → log/analytics. Phases implicit.
- **Extension model**: closed source; supported providers fixed (20+). BYOK (Bring-Your-Own-Key) for credentials. Custom cost models per route.
- **Streaming**: SSE pass-through; logs aggregate after stream completion.
- **Cross-protocol translation**: minimal — gateway is mostly transparent proxy; clients still target provider-native endpoints (e.g. `/openai/v1/chat/completions`, `/anthropic/v1/messages`). Universal endpoint is the only translation surface and it merely picks a target.
- **Domain-neutral vs LLM-specific**: heavily neutral mechanically (it IS a CDN feature), LLM-specific only in cost model, guardrails, DLP for PII.
- **Notable**: (1) Fallback expressed as **request-body array** is unique — moves routing policy from server config to client. (2) Caching keyed on request body — huge wins for deterministic eval traffic. (3) Sits on existing Workers infra, so feature surface is dominated by Cloudflare primitives, not LLM-specific ones.

## Project 4: Vercel AI Gateway + AI SDK

- **Stack**: TypeScript; gateway is hosted, AI SDK is the client-side abstraction (`packages/provider/`).
- **Core abstractions**:
  - `LanguageModelV2` (`packages/provider/src/language-model/v2/language-model-v2.ts`) — interface with `provider: string`, `modelId: string`, `doGenerate(options)`, `doStream(options) → ReadableStream<LanguageModelV2StreamPart>`, `supportedUrls`.
  - `EmbeddingModelV2`, `ImageModelV2`, `TranscriptionModelV2`, `SpeechModelV2` — parallel sibling interfaces per modality.
  - Server-side gateway is closed; client side exposes `streamText`, `generateText`, `streamObject` against any `LanguageModelV2`.
- **Request lifecycle**: client SDK → gateway HTTP → gateway selects upstream (provider preference / fallback) → upstream provider. Gateway also exposes raw OpenAI, OpenAI Responses, Anthropic Messages compatibility endpoints (three triple-source gateway).
- **Extension model**: implement `LanguageModelV2` for a new provider (client-side SDK). Gateway providers are fixed.
- **Streaming**: `doStream` returns `ReadableStream<LanguageModelV2StreamPart>` of typed parts (`text-delta`, `tool-call`, `finish` etc.) — the **stream is the abstraction**, not raw SSE.
- **Cross-protocol translation**: gateway exposes **3 source protocols** (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages) and translates internally to whichever provider is selected. SDK side, each provider implements `LanguageModelV2` and the SDK normalizes everything to typed stream parts.
- **Domain-neutral vs LLM-specific**: SDK is 100% LLM-specific by design — it models messages, tool calls, finish reasons as first-class types.
- **Notable**: (1) **Typed stream parts** are stronger than raw SSE chunks — eliminates "parse provider, re-emit as OpenAI" boilerplate. (2) `do*` prefix denotes "implementation detail, don't call directly" — convention encodes layer boundaries. (3) Modality-per-interface (LM/EM/IM/TM/SM) instead of one mega-Provider.

## Project 5: OpenRouter

- **Stack**: Proprietary; only blog/docs public.
- **Core abstractions** (from docs):
  - **Normalized "OpenAI-compatible" chat-completions schema** as the only source protocol.
  - **Provider preferences** per request: `provider.order`, `provider.allow_fallbacks`, `provider.require_parameters`, `provider.data_collection`, `provider.quantizations`, `provider.sort` (price / throughput / latency).
  - **Model variants** as routing primitive: `model: "openai/gpt-4o"`, `:nitro` (fastest), `:floor` (cheapest), `:online` (web search).
- **Request lifecycle**: validate → resolve provider list (model variant + preferences + provider health) → sort → try in order with fallback → stream/return.
- **Extension model**: closed.
- **Streaming**: OpenAI-format SSE pass-through.
- **Cross-protocol translation**: source is OpenAI chat-completions; provider-side translation OpenAI→native. They publicly added Anthropic Messages support recently but the canonical surface remains OpenAI.
- **Domain-neutral vs LLM-specific**: 100% LLM-specific — entire product is about model routing economics.
- **Notable**: (1) **Variants encoded in model string** (`:nitro`, `:floor`) — eliminates routing config explosion. (2) Provider preferences are **per-request JSON**, not config — same pattern as Cloudflare. (3) Quantization treated as routing parameter, not provider detail.

## Project 6: Helicone (OSS Helicone/ai-gateway)

- **Stack**: Rust (96.7% per repo). Separate from the Helicone observability platform (TS/Next).
- **Core abstractions**: declarative `providers.yaml` config; **OpenAI syntax as canonical**; routing strategies named:
  - "Model-based latency routing"
  - "Provider latency-based P2C + PeakEWMA" (Power-of-2-choices + Peak Exponentially-Weighted Moving Avg)
  - "Weighted distribution"
- **Request lifecycle**: middleware chain → input normalization → routing strategy → provider HTTP → output transformation. OpenTelemetry integration as observability primitive.
- **Extension model**: edit `providers.yaml` — provider definitions are config, not code. Stronger declarative posture than Portkey.
- **Streaming**: SSE pass-through with logging hook; performance budget is ~5 ms P95 (per repo README).
- **Cross-protocol translation**: source = OpenAI; target = provider-native. Single source.
- **Domain-neutral vs LLM-specific**: gateway core is mostly neutral (Rust middleware/proxy), LLM-specific only at provider mapping and cost tracking.
- **Notable**: (1) **P2C + PeakEWMA routing** borrowed from microservice load balancers (Linkerd/Twitter Finagle) — proves LLM routing benefits from classical L7 algorithms. (2) Performance-budget framing (5 ms P95, 64 MB) shapes language/lib choices. (3) Two-process split: Rust proxy + TS web app + Express collector + ClickHouse — proxy is intentionally minimal.

## Project 7: Envoy Gateway-API-Inference-Extension (GIE)

- **Stack**: Go; Kubernetes CRDs + Envoy ext-proc filter. Not a translation gateway — a **router for self-hosted inference**.
- **Core abstractions** (from `api/v1/inferencepool_types.go`):
  - `InferencePool` CRD: `Spec.Selector` (Pod label selector), `Spec.TargetPorts: []Port` (1-8 model-server ports), `Spec.AppProtocol`, `Spec.EndpointPickerRef → {Group, Kind, Name, Port, FailureMode: FailOpen|FailClose}`.
  - **Endpoint Picker Protocol (EPP)** — gRPC sidecar called by Envoy ext-proc. Inputs: candidate endpoints + model-server metrics from informers. Output: list of selected endpoints (configurable length).
  - `InferenceObjective`, `InferenceModelRewrite` moved to `llm-d/llm-d-inference-scheduler`.
- **Request lifecycle**: Envoy receives → ext-proc calls EPP → EPP applies (Predicates filter → Scorers score → Prioritize → Sample) → returns endpoint → Envoy forwards. Phases EXPLICITLY named in scheduler proposal: **Filter → Score → Prioritize → Sample**.
- **Extension model**: implement EPP as a gRPC service satisfying the EPP protocol; reference it from `EndpointPickerRef` in the InferencePool CRD. Lightweight EPP (LWEPP) is the in-tree default.
- **Streaming**: handled by Envoy (HTTP/2 + SSE pass-through); EPP only picks endpoints, never sees payload.
- **Cross-protocol translation**: N/A. Source = target = whatever the model server speaks (vLLM, TGI, etc.).
- **Domain-neutral vs LLM-specific**: protocol is generic L7 routing; LLM-specific bits are in the scheduler informer metrics (KV-cache utilization, queue depth) and `InferenceObjective`/criticality fields.
- **Notable**: (1) **Separation of policy (EPP, replaceable) from mechanism (Envoy, fixed)** — strongest contract-vs-implementation split of the 8. (2) **Filter→Score→Prioritize→Sample** is the most explicit named pipeline anyone uses. (3) FailOpen vs FailClose is a CRD field — explicit fail-mode contract.

## Project 8: Kong AI Gateway

- **Stack**: Lua on OpenResty/nginx; plugin priority system.
- **Core abstractions** (`kong/llm/` + `kong/plugins/ai-*`):
  - `ai-proxy` plugin extends `kong.llm.plugin.base`; priority 770.
  - Drivers (`kong/llm/drivers/{openai,anthropic,azure,bedrock,cohere,gemini,huggingface,llama2,mistral}.lua`) implement: `from_format`, `to_format`, `pre_request`, `post_request`, `configure_request`, `subrequest`, `header_filter_hooks`.
  - **Shared filter chain** registered by `ai-proxy/handler.lua`: `parse-request → normalize-request → enable-buffering → normalize-response-header → parse-sse-chunk → normalize-sse-chunk → parse-json-response → normalize-json-response → serialize-analytics`. EXPLICIT pipeline.
  - Sibling plugins: `ai-prompt-template`, `ai-prompt-guard`, `ai-prompt-decorator`, `ai-rate-limiting-advanced`, `ai-semantic-cache` — composable via Kong's plugin priority order.
- **Request lifecycle**: Kong native phases (rewrite/access/header_filter/body_filter/log) — the AI plugin runs as access+body_filter, internally orchestrating the 9-filter chain above.
- **Extension model**: write a Lua driver file in `kong/llm/drivers/<name>.lua` implementing the 7-method driver interface, and add a schema entry. Other AI features layered as separate Kong plugins on the same route.
- **Streaming**: explicit `parse-sse-chunk` + `normalize-sse-chunk` filters in the pipeline — SSE is a first-class concern, not a special case.
- **Cross-protocol translation**: `to_format` / `from_format` driver methods convert between Kong's normalized format and provider-native. Source = OpenAI-shape. Single direction.
- **Domain-neutral vs LLM-specific**: AI logic is a layer atop a generic API gateway (Kong) — clearest "LLM-on-top-of-generic-gateway" architecture of the 8.
- **Notable**: (1) **Named 9-stage filter chain** for AI requests — most explicit pipeline in any TS/Lua project. (2) **AI features ARE separate plugins** (prompt-guard, semantic-cache, etc.) — composes via Kong's plugin priority instead of one mega-plugin with config flags. (3) Sits on production-grade L7 proxy primitives Kong already had — proves "neutral gateway + LLM plugin pack" is viable.

---

## Synthesis

### Convergent patterns (≥5 projects agree → real contract)

1. **OpenAI Chat Completions is the canonical source schema.** LiteLLM, Portkey, Helicone, OpenRouter, Vercel-gateway, Cloudflare, Kong all normalize incoming requests to OpenAI shape before any per-provider work. Anthropic Messages support is layered on top as a compatibility surface, not as a peer canonical form. **Implication for vNext: treat OpenAI chat-completions as the hub. Multi-hub designs are not prior art.**

2. **Per-provider request/response transform pair, declared once.** Every project has the same pair of functions — call them `to_format`/`from_format` (Kong), `transform_request`/`transform_response` (LiteLLM), `transformToProviderRequest`/`responseTransforms` (Portkey), `doGenerate`/`doStream` (Vercel), `from_format`/`to_format` (Kong drivers). **Implication: this is the minimum viable provider contract.**

3. **Provider as a folder/module, not a class hierarchy.** LiteLLM, Portkey, Vercel, Kong, Helicone all use directory-per-provider with conventional files. Subclassing exists (LiteLLM) but is incidental. **Implication: file convention > inheritance.**

4. **Fallback is a first-class primitive distinct from retry.** LiteLLM (named families), Portkey (Targets+Strategies), Cloudflare (request-body array), OpenRouter (provider.order), GIE (FailOpen/FailClose). **Implication: vNext needs an explicit fallback concept; do not conflate with HTTP retry.**

5. **Streaming as a typed transform, not raw SSE pass-through.** Portkey (TransformStream), LiteLLM (BaseModelResponseIterator), Vercel (LanguageModelV2StreamPart), Kong (parse-sse-chunk + normalize-sse-chunk filters). Only Cloudflare does pure pass-through. **Implication: a typed StreamPart / Frame abstraction (which vNext already has) is convergent prior art.**

### Divergent patterns (open design space)

1. **Pipeline explicitness.** Kong (9 named filters) and GIE (Filter→Score→Prioritize→Sample) name every phase. LiteLLM and OpenRouter run implicit function-call chains. Portkey is in the middle (4 named hook points). **Open question: how many named phases vNext should expose.**

2. **Where routing/policy lives.** Server config (LiteLLM, Helicone YAML) vs per-request body (Cloudflare, OpenRouter provider preferences) vs Kubernetes CRD (GIE). **Each has tradeoffs; vNext's per-request `inheritedHeaders` design is closest to Cloudflare/OpenRouter.**

3. **Param mapping: declarative vs imperative.** Portkey declarative (`ParameterConfig` data), LiteLLM imperative (`map_openai_params` method). Declarative is more testable and supports config-only providers; imperative handles edge cases more flexibly.

4. **Hook deny semantics.** Portkey encodes hook verdict in HTTP status (246/446), GIE in CRD field (FailOpen/FailClose), LiteLLM in callback return values, Vercel in stream-part type. No convergence.

5. **Multi-source-protocol support.** Vercel exposes 3 source protocols (Chat Completions + Responses + Anthropic Messages). LiteLLM exposes 2 (Chat Completions + native Anthropic Messages endpoint). vNext currently supports 3+1 (CC, Responses, Messages, Gemini) with Cartesian translator pairs — **this is more ambitious than any project surveyed.**

### Anti-patterns observed

1. **Per-endpoint files explode (Portkey).** `chatComplete.ts`, `complete.ts`, `embed.ts`, `createSpeech.ts`, `createTranscription.ts`, `createTranslation.ts`, `imageGenerate.ts`, `createBatch.ts`, `retrieveBatch.ts`, `listBatches.ts`, `cancelBatch.ts`, `getBatchOutput.ts`, `uploadFile.ts`, `listFiles.ts`, `retrieveFileContent.ts`, `deleteFile.ts`, `createFinetune.ts` — 17 files per provider × 80 providers. Lots of near-duplicate code. **Lesson: factor per-modality, not per-endpoint.**

2. **Routing concerns leak into provider code (LiteLLM).** `Router` knows about `tpm_limit`, `cooldown_cache`, `content_policy_fallbacks` AND providers know their own retry semantics. Both grew independently → overlap. **Lesson: keep router and provider strictly separate.**

3. **Hook lifecycle implicit in HTTP status codes (Portkey).** 246/446 are unusual statuses and clients don't know to handle them. **Lesson: structured envelope > overloaded status codes.**

4. **Mega-config per request (Cloudflare/OpenRouter).** Putting fallback arrays into the request body works for the maintainer but pushes complexity to every caller. Most clients don't use it; they fall back to defaults. **Lesson: per-request override is a power-feature, server config should be the default.**

5. **Provider abstraction reinvents L7 proxy primitives (most projects).** P2C+PeakEWMA, circuit breaking, retries with jitter — all solved problems in Envoy/Linkerd. Only GIE and Kong reuse a real proxy as the substrate. **Lesson: if you can keep gateway-mechanism separate from LLM-policy, you inherit ~20 years of L7 work.**

### Cross-cutting takeaway for vNext

The clearest pattern is **two-layer separation**: a domain-neutral gateway/middleware substrate (Hono, Envoy, Kong, nginx, Workers) underneath an **LLM-specific provider+routing layer**. Projects that conflate them (LiteLLM) accumulate scope; projects that separate them (Kong, GIE, Helicone Rust gateway) stay small. vNext's `packages/gateway/` + `apps/platform-*` split is consistent with this.

The **provider contract** that 7/8 projects converge on is: a per-provider module exposing `(request) → providerRequest`, `(providerResponse) → response`, `(providerStream) → StreamPart*`, plus auth/URL builder. Anything richer (subclassing, declarative param maps, gRPC sidecars) is a stylistic choice on top of that core.

The **cross-protocol translation** problem is unique to vNext's ambition — no surveyed project does Cartesian (source × target) translation. Most pick one source (OpenAI) and do per-provider translation. vNext's translator-registry approach is novel; design carefully because there's no prior art to copy.
