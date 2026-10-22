# Loki upstream with a standalone Windows sign-in assistant

Status: implementation direction approved in conversation; sync v1 implemented and fixture-tested. Real WAM and target-runtime egress acceptance remain pending. See `../../loki-sync-v1.md` for the precise contract.

## Outcome and ownership

The user chose an independent Windows application, replacing the initial proposal to extend llm-relay. The `win-llm-relay` team member implements and tests the Windows application in a separate project. The Leader implements the vNext side. The existing llm-relay installation, repository, startup registration and service remain untouched.

Windows acquires short-lived Loki Bearer tokens through WAM and proactively uploads them to a single paired vNext upstream over HTTPS. vNext calls Loki directly. WAM refresh credentials remain on Windows. There is no inbound Windows listener, generic authentication job queue, or inference relay in this iteration.

## Windows lifecycle

- A standalone current-user desktop application supplies a real parent HWND for interactive WAM.
- Publish a self-contained Windows x64 directory, retaining native libraries. Initially avoid trimming, NativeAOT and single-file extraction.
- Install/copy into a stable per-user application directory before registering current-user startup. Do not register a build or temporary path.
- Enable launch at Windows user sign-in as requested. Provide a visible startup toggle and tray commands to show the window and exit.
- Startup uses `--background`, enforces a single instance and never opens interactive authentication automatically.
- Closing the window keeps the application in the tray; Exit stops the process. Windows logoff stops it normally. No SYSTEM service or Session 0 execution.
- Use one renewal operation per binding. Schedule from the actual token expiry with a five-minute refresh margin, bounded backoff and jitter. Recompute on wake/network recovery; never spin on expired tokens or cached tokens that do not advance expiry.
- An interaction-required result pauses silent attempts until the user chooses Sign in. Cancellation leaves the previous valid binding intact.
- Store the scoped synchronization secret and stable account binding with current-user Windows protection. Access tokens need not be persisted locally. Never log token-bearing objects or raw MSAL exception text.

## Fixed OAuth profile

Profile ID: `loki-df-v1`.

| Field | Value |
| --- | --- |
| Client application | `aebc6443-996d-45c2-90f0-388ff96faa56` |
| Authority | `https://login.microsoftonline.com/organizations` |
| Scope | `42c8f7bd-c7a8-4ba9-bc1c-91edfb716247/.default` |
| Default Loki origin and prefix | `https://loki.delve.office.com/api/v1/llmapi` (overridable per upstream) |
| Required headers | `X-ClientType: Copilot`, `X-ClientFeature: LlmApiProxy` |

These values come from pi_loki commit `563cc73a14fc82dea3dc451c8cb9ad67f82eb63d`. They are a reference configuration, not proof that its app registration supports MSAL.NET broker login. Do not inherit ambient `LOKI_*` overrides or accept an arbitrary OAuth profile from the gateway.

The helper returns a nonempty access token, an actual future expiry, and stable account identifiers supplied by MSAL (home account ID plus tenant ID). A username/login hint is not a stable binding. Silent acquisition must match that identity exactly; no first-account fallback. Missing expiry or identity fails closed. Interactive acquisition is user initiated, and a different identity requires explicit re-pairing.

The application must verify that MSAL.NET can use this client registration and its broker redirect URI. A failure here is reported as a compatibility result; it does not authorize modifying enterprise app registration or choosing another client ID.

## Pairing and synchronization contract v1

All wire timestamps are integer Unix milliseconds. All responses use `Cache-Control: no-store`. JSON request bodies are bounded to 64 KiB. Authentication secrets are sent only in headers or an explicit pairing response, never URLs.

Management operations require a real vNext user session and the existing owner/admin authorization gate. An inference API key is not a management grant. Management creates a Loki upstream and issues a random, upstream-scoped synchronization secret. A pairing document contains gateway origin, upstream ID, generation, profile ID and that secret. The user imports it into the standalone assistant; no long-lived management session is stored there.

Assistant API (same-origin HTTPS only; disable automatic redirects):

| Method and path | Authentication | Purpose |
| --- | --- | --- |
| `GET /api/loki/sync/:upstreamId` | `Authorization: Bearer <syncSecret>` | Read this binding's generation, revision, profile and non-secret health |
| `POST /api/loki/sync/:upstreamId` | Same scoped secret | Compare-and-swap credential/status update |

The sync router authenticates its own scoped secret; it does not turn that secret into a gateway user session. The secret cannot list or mutate any other upstream. Store only its cryptographic hash on the server. Bind it to upstream row incarnation, owner, profile and a fresh random generation. Re-pairing atomically replaces the generation, hash, stable identity and token state. Deletion/recreation cannot revive old authority.

Credential update shape:

```ts
interface LokiSyncUpdate {
  version: 1
  generation: string
  expectedRevision: number
  requestId: string
  status: "authorized" | "interaction_required" | "failed"
  credential?: {
    accessToken: string
    tokenType: "Bearer"
    expiresAt: number
    account: { homeAccountId: string; tenantId: string }
  }
  errorCode?: "interaction_required" | "broker_unavailable" | "invalid_result" | "acquisition_failed"
}
```

Only `authorized` carries a credential. Require more than 60 seconds of remaining token validity on acceptance. An initial accepted credential fixes the stable identity. Later updates must match it. Status reports cannot silently change identity or overwrite a still-valid token. Exposed status distinguishes helper reauthentication needs from whether an already accepted access token is still usable.

Server updates use an atomic upstream state mutation. Inside that mutation, recheck the secret hash, generation, identity and expected revision. Revision conflicts return 409 with no credential data. The client rereads binding state and reacquires rather than retrying an older token at a newly fetched revision. Same request ID plus identical payload can return the prior receipt while it remains the last accepted operation; reused ID with different payload is a conflict. After a later accepted update, replaying an old request fails its original CAS. An HTTP success never echoes token or sync secret.

The gateway trusts the authorized assistant to report MSAL identity/expiry metadata. This is not independent JWT validation; it must not be described as such. Actual Loki authorization is verified by a model-list request and inference.

## Loki provider and gateway UI

- Add a dedicated Loki provider package. Keep WAM and OS code out of the gateway/provider runtime.
- Read credentials authoritatively at discovery and selected dispatch. Reject expired, revoked or replaced binding state before egress. No refresh-token implementation on CFW.
- Use the upstream's HTTPS base URL (or the default above), fixed Loki headers, dynamic model discovery and only the endpoints advertised for each model. Do not expose unsupported endpoints based on model-name guesses. Endpoint edits preserve the OAuth profile and Windows pairing.
- Reuse existing protocol translation and streaming infrastructure. Start with models, Messages, Responses and Chat Completions when advertised; do not claim tools/images/opaque-state replay beyond tested capabilities.
- Public upstream DTOs contain only profile, health and expiry metadata. Credential state and sync hashes never appear in ordinary dashboard/export payloads without the existing explicit secret-export semantics being reviewed.
- Dashboard provides Create Loki upstream, Pair/re-pair Windows assistant, Copy pairing document, revoke and status. Pairing-secret display is intentional and one-time; ordinary lists never contain it.
- Re-pair and delete invalidate cached catalogs/routing authority using existing generation semantics. Routine token updates do not silently change model configuration.

## Validation and release boundaries

1. Windows: build/test, publish size, native broker load, real HWND, single instance, startup enable/disable, quoted paths with spaces, background launch without prompts and bounded retries. Report simulated tests separately from real WAM results.
2. Gateway: real SQLite tests for owner isolation, scoped-secret isolation, expiry, stable identity, CAS races, idempotent retry, re-pair/delete fencing and DTO redaction. Provider fixtures verify catalog capabilities, fixed headers, expiry checks, stream cancellation and protocol selection.
3. Build vNext and run its required local checks, including Worker dry-run. A dry-run does not prove Cloudflare egress.
4. With the user completing the native login flow, test Windows acquisition and a local gateway catalog/inference request without printing tokens.
5. After an explicitly authorized CFW deployment, verify catalog plus one inference from the actual Worker. If Cloudflare egress is rejected, report the boundary; do not silently add a Windows inference relay.

No automatic reboot/logoff is needed to test registration. Actual post-reboot behavior remains unverified until the user next signs in or explicitly requests that test.

## Evidence

- Windows member independently verified the transferred ZIP and all six manifest entries. ZIP SHA256: `302a040f6e491d9d6abd539e334a556baf540f5be802c57eb60c3f376d249ad1`.
- The reference has unsafe first-account and guessed-expiry fallbacks; they are excluded from this design.
- MSAL.NET requires a parent HWND and broker redirect URI registration: https://learn.microsoft.com/en-us/entra/msal/dotnet/acquiring-tokens/desktop-mobile/wam
- Self-contained deployment does not imply embedded native libraries: https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview
