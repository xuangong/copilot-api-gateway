# Loki Windows authentication delivery evidence

## Scope

Gateway changes are uncommitted in branch `feat/loki-windows-auth`, isolated from the existing `vNext` checkout. The user subsequently authorized Cloudflare deployment and the Windows helper update. The live rollout is recorded below. No commit or push has been performed.

The independent Windows project is `C:\Users\xanzh\projects\loki-login-helper`. The existing llm-relay project, process and startup entry were preserved. This separation keeps Windows identity/broker deployment independent from the cross-platform inference relay.

## Windows startup

The Windows member installed the initial WAM/lifecycle build at:

`C:\Users\xanzh\AppData\Local\Programs\Loki Login Helper\LokiLoginHelper.exe`

HKCU `Software\Microsoft\Windows\CurrentVersion\Run`, value `LokiLoginHelper`, points to the quoted installed executable with `--background`. The application has a startup toggle, single-instance handling, tray Show/Exit, and close-to-tray behavior. Background startup does not open WAM. The helper runs in the signed-in user's desktop session.

Member-run checks cover enabling/disabling/restoring the startup value, a path containing spaces, hidden background startup, duplicate launch, showing the existing window, close-to-tray, explicit exit, actual HWND, app-local coreclr and native broker DLL loading. The source/manifest evidence archive SHA256 is `8950838f745681b29cb1306e8b9c3e03914c4f0d6f609f266470beafa38c12ec`; Leader independently verified the archive and its 27 manifest files and reviewed lifecycle/authentication source. Windows execution results were produced by the Windows member, not rerun on macOS.

The initial build has 30 offline checks and a 175.57 MiB self-contained win-x64 directory. Its token sink only validates and discards an in-memory token. A subsequent HTTP/pairing build is separate from that installed process so the user's pending interactive acceptance is not interrupted.

The first HTTP source archive (`fc14842c63841c28177286871a1c08e117208419a55cfe887a7941eb1e5cc552`) and all 30 manifest entries were independently verified by Leader. Its 60 member-run offline tests exercise pairing parsing, DPAPI state, HTTPS/redirect policy, bounded responses, status-only updates, CAS recovery and exact-body retries. Independent static review found that an operation deadline was incorrectly treated as user cancellation, stopping future renewal. The final fix separates user cancellation from the operation deadline: deadlines produce `request_timeout` and enter retry backoff, while explicit user cancellation pauses renewal. Leader independently reviewed the changed source and verified the final archive SHA256 `4e8a700fdc906ea27eb48388c1582934f685af3338510f49cb04689e48503543` plus all 32 manifest files after resource sharing was restored. The included Windows execution report records 64 passing offline tests, including a stalled response body, exact pending-body/requestId retry and explicit cancellation. These tests were run by the Windows member, not rerun on macOS. Pairing secret and upstream ID parsing now enforce the exact protocol formats. Resource `71795087-b719-4d35-a58b-39eea23ee25b` contains this source and evidence; its 175.64 MiB build was subsequently installed under the user's rollout authorization, as recorded below.

## Gateway verification

- 25 focused tests / 156 assertions passed after review fixes: state parser/CAS/idempotency, management authentication, pairing/revocation, disabled owners, full-app scoped-key isolation, public DTO/backup redaction, model routing and inference.
- Native Messages, Responses and Chat Completions requests pass through the real app and SQLite repository into a synthetic Loki fetcher; fixed origin, headers and redirect refusal are asserted. This is not live Loki access.
- Workspace typecheck passed.
- ESLint passed with 41 existing warnings and zero errors.
- Dashboard build and Cloudflare Worker dry-run passed. Dry-run produced a Worker bundle without deploying it.
- The broad `ci:local` run reached 6730 passes, 2 skips and 6 failures. All six failures are PowerShell wrapper fixtures; `Join-Path` cannot load on this host. Running those fixtures in the unchanged original checkout reproduced the same six failures. The broad run preceded the final additional owner-transfer regression; that fix was checked in the 25-test focused run and final typecheck/lint/dry-run.
- Initial fresh-worktree missing dashboard assets were fixed by running the existing UI build. A local ignored dependency link resolved the existing D1 test's Wrangler import; its two actual-D1 tests then passed.
- Independent review reproduced old pairing authority surviving generic owner transfer. The generic Loki transfer operation is now rejected; a new owner must create a new paired upstream.

## Remaining acceptance

- User-initiated WAM sign-in must establish whether this client registration works with MSAL.NET Broker. DLL loading and client construction are insufficient evidence.
- The reviewed HTTP/pairing build is installed; actual gateway pairing, WAM sign-in and successful synchronization still require acceptance.
- Actual next-logon startup, clean-machine installation, sleep/resume and network-loss behavior remain unverified beyond offline scheduling and launch tests. No logout or reboot was initiated.
- Dashboard browser acceptance is incomplete: Chrome/Chromium could not start in this host context and the alternate computer-use surface was unavailable. Source, business-logic tests and the build were verified.
- Real catalog discovery and inference from the target CFW runtime remain pending. No enterprise registration changes were performed.

See [the protocol](loki-sync-v1.md) for configuration, authorization and recovery rules. Imported configuration backups require fresh pairing; they do not restore Loki token/sync authority. Pricing and opaque replay are not advertised by the initial provider.


## Authorized live rollout

The user authorized deploying this implementation to CFW and running the independent helper on Windows for request testing.

- Target: `https://token.xianliao.de5.net`, Worker `copilot-gateway-vnext`.
- Deployed version: `b566605d-f3c6-4636-ad41-969777a9bc8f`, 100% traffic confirmed by a subsequent deployment-list read.
- Previous version: `26c18973-c46c-4bb3-a98e-436b90a00c6e` (rollback reference).
- Source: base `c3fd3071fc2ff28324a919ecc70c5a74b38d737e` plus this uncommitted worktree. Release tag `loki-a10f4ea9`; SHA256 of the 2,778-file source manifest: `a10f4ea9047d201ae7ac36f665f1a2bd7a01e55f09e2aa6d7ee9463e831c46eb`.
- Added a pairing JSON download button so the dashboard output connects directly to the helper's file importer. Both languages describe Import pairing → Sign in and the Windows online requirement.
- Fresh pre-deploy checks: 25 tests / 156 assertions, workspace typecheck, lint (0 errors / 41 existing warnings), UI build and Worker dry-run passed. Remote migration apply reported no pending migrations. Deployed with `--keep-vars`.
- Live curl verification: `/health` 200; dashboard 200 containing the new download action and pairing filename; unauthenticated sync and management endpoints 401, with sync `Cache-Control: no-store`. Python urllib's default client received Cloudflare 1010 before reaching these routes; this is distinct from the successful curl checks and actual helper transport remains to be tested.
- Windows member verified no active WAM operation, cooperatively exited the old app, installed the reviewed build at the existing fixed path and opened the new window. All 478 installed file hashes matched the reviewed publish manifest. New-version startup toggle, hidden background launch, single instance, show, close-to-tray, exit and opening/cancelling the native pairing file dialog passed. No Sign in was clicked.
- Installed evidence resource `1673c005-d7ad-4fd3-aa6a-6e78a14f992d`: SHA256 `adade563ead7e7d7b5a5e640ec9f9c086ed7b70af8d4fedb3379ddcab856dc55`. Leader independently verified the archive and all five manifest entries. Runtime/UI checks were executed by the Windows member.

## User acceptance flow

1. Sign in to the gateway dashboard and open Upstreams → + Loki. Create a named upstream and download `loki-pairing.json`.
2. In the Windows helper, choose Import pairing file and select the downloaded file. Verify the displayed gateway origin is `https://token.xianliao.de5.net`.
3. Click Sign in and complete organization account authentication. Successful unpaired local authentication alone is insufficient: the paired helper must report gateway synchronization success.
4. Refresh the dashboard upstream list, confirm token received, then run the upstream probe to fetch the real Loki model catalog from CFW.
5. Test an actually advertised model. Use the pinned `upstreamId/model` form to ensure the request targets this Loki upstream rather than another upstream with the same model name.

Windows must remain signed in and online for automatic renewal. CFW can use an already uploaded token until expiry while Windows is offline; an expired token requires the helper to renew and synchronize. Re-pairing explicitly invalidates the previous assistant binding.


### Browser pairing handoff

The Windows member could not confirm the browser's management session: automatic approval review blocked opening the target page and inspecting its UI state with `blocked by policy`, without a more specific reason. No cookie/token was extracted and no alternate method was used to bypass the denial. Login availability is unknown, not confirmed absent. The user must complete the dashboard pairing and Sign in steps above. No live synchronization, catalog or inference success is claimed yet.


## Conversation-header correction (2026-10-20 local time)

The user reported a live inference 400: `Missing required header 'X-ConversationId'`. The reference project's `streams.ts:31` adds this dynamic header for every inference, using an explicit session ID or `sanitize.ts:31`'s system/first-user-prefix hash. Our initial provider only copied the static client headers and omitted this requirement. Model discovery and credential synchronization succeeding therefore did not establish inference compatibility.

The Loki provider now supplies `X-ConversationId` on Messages, Responses and Chat Completions calls. A bounded printable explicit conversation/session header is used when present on ProviderRequest; otherwise a SHA-256-derived identifier uses the upstream ID, system/instructions and first user content. Later turns do not change that prefix. Requests with no user prefix or explicit session use a random UUID. Prompt text is never copied directly into the header. The existing Messages ingress supports provider-allowlisted headers; current native Responses/Chat ingress does not forward client headers and uses the derived fallback. No generic ingress behavior was changed.

Tests first reproduced the missing-header failure. The full-app/SQLite inference fixture now rejects requests lacking the header, and tests verify explicit-header precedence, bounded fallback, stable multi-turn IDs and all three native inference paths. Final focused run: 28 passed, 170 assertions. Workspace typecheck, scoped ESLint, UI/Worker dry-run and diff checks passed; remote migration apply reported no pending migrations. Fix-file manifest SHA256: `9ed4eaa46fcdf8327c08b6e2d6903876ccf44340fd01f55741706c207842e452`. Windows authentication code was not changed.

Deployed this correction to CFW version `39be75ca-75f5-498a-9a8d-dd4af6f1518e` with `--keep-vars`; a fresh deployment-list read confirmed 100% traffic and live `/health` returned 200. Previous version `b566605d-f3c6-4636-ad41-969777a9bc8f` is the rollback reference. A real user inference retry is still needed to verify Loki's response after this header correction.

## Web Search / Claude 5.5 thinking correction (2026-10-20 local time)

The user reported `400 Upstream rejected the request` from Claude Code Web Search subcalls. Read-only production usage metadata showed Opus 5.5 and Haiku 5.5 calls; no retained request dump was available, so the exact failed client body was not recovered. The shared Messages search shim already applies to Loki and Copilot alike. The provider-specific thinking adaptation present in Copilot and the `pi_loki` reference was absent from Loki.

Minimal live requests to the configured Loki endpoint reproduced `invalid_body` with the same error text. Only synthetic prompts were sent; credentials stayed in process memory and neither credentials nor model output were printed:

| Model / request difference | HTTP result |
| --- | --- |
| Haiku 5.5, thinking omitted / disabled / adaptive | 200 |
| Haiku 5.5, enabled + budget_tokens | 400 invalid_body |
| Haiku 5.5 + ordinary web_search tool, enabled / adaptive | 400 / 200 |
| Opus 5.5, disabled / omitted | 400 / 200 |
| Sonnet 5.5, disabled / omitted | 400 / 200 |
| Haiku 4.5, enabled + budget_tokens | 200 |
| Haiku 5.5, adaptive + temperature 1 | 200 |

The fix is deliberately scoped to the verified Claude 5.5 families: convert enabled/budget thinking to adaptive, preserving explicit display and output effort; omit explicit disabled thinking for Opus/Sonnet 5.5. Haiku's working disabled mode, older-model budget thinking, temperature, tool definitions and model IDs remain unchanged. This is narrower than the reference sanitizer, whose all-5.5 disable rule contradicted the live Haiku result. Other reference sanitizer differences were not bundled into this fix.

Regression tests first failed with the same 400 through the real gateway app and SQLite repository. After the fix, the fixture traverses hosted-tool conversion, Loki egress, a synthetic search service and native `server_tool_use`/`web_search_tool_result` events. Focused regression: 43 passed, 202 assertions, including existing Copilot thinking and shared search tests. Workspace typecheck, scoped ESLint, diff check, UI build and Worker dry-run passed. Remote migration apply reported no pending migrations.

Deployed with `--keep-vars` to version `fc53043a-2830-429d-bffd-b07f805c0edc`; a fresh deployment-list read confirmed 100% traffic and `/health` returned 200. Previous version `39be75ca-75f5-498a-9a8d-dd4af6f1518e` is the rollback reference. The Windows helper and existing pairing were not changed.

A smoke-test setup initially used the incorrect `model@upstreamId` pin format from this document and received catalog-unavailable 503 before model execution. Source inspection confirmed the actual syntax is `upstreamId/model`; the acceptance instructions above and smoke request were corrected. This setup error is separate from the user's upstream 400.

Post-deploy live acceptance: using the existing authorized gateway API key only in memory, a native streaming Messages request pinned to `up_loki_e04700515abf4a5c8280cd11114d9f78/claude-haiku-5.5` asked for official Bun documentation with `thinking: enabled`, budget 1024 and a native web-search tool. CFW returned HTTP 200, `server_tool_use` and `web_search_tool_result` blocks containing actual `web_search_result` entries, no search error codes, and the expected `pause_turn` stop reason. The smoke did not replay the continuation or the user's private conversation; the original failing client bodies remain unavailable. The user should retry those same searches to confirm their full workflow.


## Opus 5.5 forced Web Search correction (2026-10-20 local time)

The subsequent user retry established a separate incompatibility that the earlier automatic-search smoke did not cover. A temporary content-free diagnostic recorded only fixed parameter enums, counts and numerical limits: the failing Web Search subcall used Opus 5.5, disabled thinking, one search tool, forced `tool_choice: {type: "tool", name: "web_search"}`, 64000 maximum tokens and high effort. Disabled thinking was already removed at egress, but the forced choice still produced 400. No prompt, query, account, token or free-form tool name was logged. The local Claude Code binary's embedded Web Search implementation corroborated this request shape. The `pi_loki` thinking sanitizer alone does not solve this forced-choice case.

Live comparison against the configured Loki endpoint returned 400 for Opus 5.5 forced search with both native and ordinary tool definitions. Opus automatic tool choice succeeded through CFW with actual search results and a subsequent answer turn. Haiku's forced mode also worked, but the user requires Opus 5.5 support, so the correction does not substitute Haiku or another model.

The compatibility rule is limited to native Messages requests targeting Loki Opus 5.5 with exactly one hosted web-search tool and a forced choice naming that tool. The gateway keeps the model, uses automatic choice upstream and adds an instruction requiring search. It buffers up to 256 KiB of leading events until a real `web_search` call appears; only then does the existing shim execute search and return native search-result blocks. A text-only response becomes an explicit error, not a successful unsearched answer. Upstream errors discard the unverified prelude, cancellation closes the iterator, and excess buffering aborts the producer. Ordinary client tools, Copilot and other protocols keep their existing behavior. This is a scoped compatibility adaptation, not a claim that Loki supports arbitrary forced tool choice on Opus.

Verification: 114 focused tests / 382 assertions across 20 files passed, including native-stream and non-stream rejection of unsearched answers through the real app and SQLite repository, search results, model preservation, bounded buffering and cancellation. Workspace typecheck, full ESLint (zero errors, 41 existing warnings), framework-purity check, UI build and Worker dry-run passed. Fresh scoped lint after the type correction and diff checks also passed. The previously documented host PowerShell failures remain the limit of the earlier broad CI run; no claim of fully green broad CI is made.

Deployed with `--keep-vars` to version `05cf8477-4012-4d69-b2fc-be31491d928d`. Remote migration apply reported no pending migrations. Rollback reference is `a2cce4fd-458c-416c-b323-a1aa89b07bee`, the diagnostic-only version. Windows helper, pairing and login were unchanged.


Live acceptance after deployment: a fresh deployment-list read confirmed 100% traffic on `05cf8477-4012-4d69-b2fc-be31491d928d`; `/health` returned 200. The same configured gateway key was read into process memory and used only against the authorized gateway. A pinned Opus 5.5 Messages request reproduced the user's failing Web Search shape (disabled thinking, forced named search, high effort, 64000 maximum tokens, one hosted search tool with max_uses 8) and the user-provided query `北京天气预报 2026年10月21日`. It returned HTTP 200, model `claude-opus-5.5`, native `server_tool_use` and `web_search_tool_result` blocks containing real search results, no error events and `pause_turn`. Replaying those results with automatic choice for the answer returned HTTP 200, the same Opus model, thinking/text blocks, no error events and `end_turn`. Credentials and response content were not printed or saved. This verifies the forced-search request and continuation through CFW; the user's full Claude Code session remains a separate retry acceptance.

A second live forced-search request used the user's earlier `MetaHuman teeth material shader subsurface profile enamel how it works` query with the same Opus parameters. It also returned HTTP 200, model `claude-opus-5.5`, native search call/result blocks with actual search results, no error events and `pause_turn`. Its continuation was not repeated; the weather request covered that path.


## Credential-expiry incident and silent renewal investigation

After the search correction, the user reported `502 loki_credential_unavailable`. The previously synchronized token expired at 2026-10-20 01:12:09 +08:00. A read-only D1 projection (no credential, secret or account identifiers selected) found revision 4, authorized status, matching bound/credential identities, an intact pairing, synchronization at 01:13:49 and new expiry at 02:36:36. Thus the old expiry and new successful synchronization were about 100 seconds apart. The Windows member independently read the running helper UI at 01:14:37 and confirmed that same new expiry and successful gateway sync; no authentication button was clicked. A subsequent real pinned Opus 5.5 request returned 200/end_turn. The UI retains only the latest outcome, so this does not establish whether the successful acquisition was automatic or manually initiated.

The reference `pi_loki/auth.ts` exposes `refresh()` via silent WAM and sets the application's renewal deadline five minutes before actual expiry. `wam.ts` stops reusing its process cache at that threshold, but `wam-helper.mjs:55` calls `acquireTokenSilent` without explicit force refresh. The broker retains the renewal credentials; CFW receives only an access token and cannot renew it independently.

The installed .NET helper also schedules five minutes early, but rejects returned tokens with at most five minutes remaining and backs off after such failure. Its silent builder did not request force refresh. A broker returning the near-expiry cached token is therefore a source-supported failure path, not a proven reconstruction of this incident. Sleep/offline and transient acquisition or upload failures are not excluded. Only two revisions were added since the earlier revision 2 snapshot, so multiple successfully uploaded failures cannot be inferred.

The [MSAL.NET API](https://learn.microsoft.com/en-us/dotnet/api/microsoft.identity.client.acquiretokensilentparameterbuilder.withforcerefresh?view=msal-dotnet-latest) supports bypassing cached access tokens. The exact [MSAL 4.91.0 RuntimeBroker implementation](https://github.com/AzureAD/microsoft-authentication-library-for-dotnet/blob/4.91.0/src/client/Microsoft.Identity.Client.Broker/RuntimeBroker.cs#L395) implements this through `AccessTokenToRenew` and another silent native-broker call. A bounded near-expiry refresh correction is being prepared in the independent Windows project; it has not yet been installed or live-validated. Normal cache hits remain allowed, identity validation stays strict and no interactive fallback is introduced.

The user requested a more aggressive renewal buffer. The staged policy is now a separate 15-minute renewal lead (while retaining the five-minute minimum accepted credential lifetime), one forced silent refresh when a cached result falls within that lead, and transient retry delays of 30–60 seconds including jitter. Terminal interaction/pairing states still pause. The gateway's existing status-only updates retain a still-valid prior credential until replacement; no gateway change or acceptance of expired credentials is planned.

The Windows renewal build was delivered as resource `0407b219-9643-4ef6-b033-a4214122ce3f`, ZIP SHA256 `3fc41b5d72c33a384442f334245fa5f3213afc82c9d91af72d63e7043d5b1409`. Leader independently verified the ZIP and all 34 manifest entries, reviewed the silent acquisition adapter and the final buffer/backoff changes. Member-run offline verification reports 88 passing checks, covering the 15-minute boundary, 14-minute cached result forcing refresh, 16-minute cache reuse, bounded single refresh, account/tenant/environment/subject mismatches, missing/expired/short tokens, cancellation/deadline and 30–60 second retries. Locked restore/publish passed; the self-contained output remains 478 files, 184,185,349 bytes. Windows tests were executed by the member, not rerun on macOS. Installation is proceeding after checking that the existing helper is idle, preserving existing pairing, binding and startup configuration.


Installation of the 88-check build exposed a second, independently reproducible source defect. The member confirmed idle state, cooperatively stopped PID 4304 and launched installed PID 39932 at 01:23:20 +08:00. All 478 file hashes matched the reviewed build; pairing/binding files were unchanged during installation and startup registration stayed intact. The automatic startup attempt then reported `interaction_required`, with no interactive window. D1 revision 5 recorded that status at 01:23:33 while retaining the valid credential expiring at 02:36:36. This startup is a failed silent-acquisition acceptance, not a successful refresh test. Installation evidence resource `b4b7c57f-cfc1-4122-8c5e-9533239c4932` (SHA256 `a759b8aa3007372050811a35fa81f1ddf5f053a009b41f195bc3feb88a7e7852`) and its three manifest entries were independently verified.

Exact MSAL 4.91.0 source explains the cold-process discovery gap: `BrokerOptions.ListOperatingSystemAccounts` defaults to false; `RuntimeBroker.GetAccountsAsync` returns an empty list when it is false. `ClientApplicationBase` merges that list with the process-local application cache. The helper has no persistent MSAL cache, so a restarted process cannot find its saved account binding under the original options. The correction enables broker account discovery and retains exact home-account/environment matching plus tenant/subject validation, without choosing an OS-default or first account and without saving another token cache.

Existing paused state is preserved. An explicit Check silently action will be able to retry the existing binding once, still without interactive fallback, while automatic startup/timer remains paused. Successful validation and synchronization restore normal renewal; failure retains the pause. This avoids guessing whether old paused state came from discovery failure or an actual interactive requirement. The cold-start correction is being staged and reviewed before another installed acceptance.

The final cold-start and paused-retry source is resource `33e0d397-830f-45ce-bbb9-62b8598f9feb` (77,761 bytes, SHA256 `554c9a89d29a48958f7d2288878b2381e4dc152bc8ba487dfa81b423637b77a9`). Leader independently verified all 36 manifest entries and reviewed the final changes. Member-run offline checks total 101 passed. In addition to broker discovery and explicit silent recovery, the final correction preserves a prior pause when credential upload fails, permits exact-body pending synchronization without another WAM call, and clears the pause only after an authorized receipt; status-only receipts leave it paused. Actual AuthService control flow with an isolated store and injected sink covers these transitions. The preceding 99-check snapshot was superseded and is not the installation target. Team message capacity briefly blocked sharing, then the resource was successfully granted and downloaded through the normal Team resource channel. Final installation/live cold-start acceptance remains pending.

### Final installed acceptance (2026-10-20 +08:00)

Team delivery recovered and the final installation task was accepted. The Windows member verified all 478 installed files against the reviewed publish output, preserved pairing/binding during installation and retained the startup registration. The new process started at 01:38:53 and correctly retained the existing pause. One explicitly authorized Check silently action at 01:39:11 succeeded without Sign in, interactive fallback or re-pairing. Leader independently read D1 revision 6 with `authorized`, no error, expiry `1792434997116` and synchronization time `1792431555041`.

After that success, the member cooperatively restarted the helper once with `--background` at 01:39:47 (PID 30888). The cold process automatically acquired and synchronized silently; its UI showed Authorized / Gateway accepted at 01:40:22. Leader independently read revision 7 with `authorized`, no error, expiry `1792434996724` (02:36:36 +08:00) and synchronization time `1792431600550`. A real pinned Opus 5.5 request returned HTTP 200, `claude-opus-5.5`, `end_turn`, with no credential-unavailable error. The helper remains in the tray with startup enabled; llm-relay was not changed.

These results validate installed silent recovery, broker account discovery after a cold process restart and CFW acceptance. They do not validate a naturally occurring near-expiry forced renewal: the token still had more than 15 minutes remaining. The next scheduled renewal is approximately 02:21:36 +08:00 while the helper is running and the computer is awake. The installed policy is a 15-minute lead, bounded near-expiry force refresh and 30–60 second transient backoff; interactive requirements still pause renewal.

The member uploaded installation evidence resource `5b4cd758-9887-42a8-952c-70d8e1394350` (3,146 bytes, reported SHA256 `1bdf8dd17c0f2bc05566d776b935d72d0341c0219c07698bbf4bdbe8e0ed6d5d`). Team communication capacity blocked attachment delivery and the follow-up request, so Leader has not downloaded or independently verified this installation archive. Member runtime reports and Leader's independent D1/inference checks above are distinguished from archive verification. No additional CFW deployment, commit or push was performed for this Windows-only correction.

### First natural renewal failed (2026-10-20 +08:00)

The user reported another credential-unavailable 502 after the first scheduled renewal. At 02:39:52, Leader read D1 revision 8 with `interaction_required`, synchronization time `1792434100250` (02:21:40) and unchanged expiry `1792434996724` (02:36:36). The failure report arrived about 15 minutes before expiry, consistent with the new timer, but no replacement credential was synchronized before expiry. This is a failed natural-renewal acceptance. Earlier cold-start/cache acquisition successes do not establish refresh success.

The same installed process (PID 30888, reviewed 101-check DLL hash) subsequently showed Authorized and expiry 03:55:55. The user explicitly confirmed clicking Sign in. Leader verified D1 revision 9, authorized, expiry `1792439755608`, synchronization time `1792435209098` (02:40:09). Recovery was manual, not automatic; the expiry-to-recovery gap was approximately 3 minutes 33 seconds.

The existing UI overwrites the previous failure on success. Account lookup failure and MSAL UI-required exceptions both map to `interaction_required`; initial and forced silent calls share the outer catch. Thus the available record does not identify which acquisition phase failed, and force-refresh failure cannot yet be asserted. A minimal in-memory diagnostic extension is being prepared to retain fixed failure phase, trigger source, attempt UTC and allowlisted error/correlation data across subsequent success, without account, credential or raw exception content. No automatic interactive fallback is planned.

The previously blocked installation evidence attachment was successfully granted during this investigation. Leader downloaded resource `5b4cd758-9887-42a8-952c-70d8e1394350` through Team Resource and independently verified its ZIP SHA256 and all seven manifest entries. This closes the archive-verification gap above but does not change the failed natural-renewal result.

### Controlled reproduction identified account lookup failure

The diagnostic/manual-refresh build passed 136 member-run offline checks. Leader reviewed resource `b013d4a4-bc86-49bb-a347-75a69dfab080` and independently verified ZIP SHA256 `c5e692fe2ea0d33c5cbcee0017fca9d60918e2e5e4c2a458fa8515a5e76142c4` and 39 manifest entries. It retains only a bounded in-memory safe failure snapshot, adds an explicit silent refresh action, and does not change automatic renewal policy or permit interactive fallback.

The Windows member installed it with all 478 hashes matching, preserving pairing/binding/startup. PID 5020 started at 02:56:24; automatic startup acquisition succeeded with expiry 03:55:56. One authorized Refresh silently action at 02:57:09 then failed in `account_lookup`, source `manual_refresh`, code `interaction_required`, with force-started and force-completed both false. The forced API was never entered. D1 revision 11 independently confirmed that failure status while retaining the valid credential. The helper paused and remained in the tray; no Sign in, second refresh or re-pairing was performed. Leader independently verified the installation evidence archive `6551f71c-eaaa-4e7b-8730-fc863fb07fae`, SHA256 `6af5447608a745bc654b80c7ec87c766a14d0cbc4b62bb09d491ad68c4ee8d48`, and all six manifest entries.

Exact MSAL 4.91.0 source rules out a simple cache-plus-broker duplicate as the default explanation. [ClientApplicationBase.MergeAccounts](https://github.com/AzureAD/microsoft-authentication-library-for-dotnet/blob/4.91.0/src/client/Microsoft.Identity.Client/ClientApplicationBase.cs#L272) prefers cache accounts and eliminates broker accounts with the same HomeAccountId. [TokenCache](https://github.com/AzureAD/microsoft-authentication-library-for-dotnet/blob/4.91.0/src/client/Microsoft.Identity.Client/TokenCache.ITokenCacheInternal.cs#L136) stores the account under PreferredCache but returns AuthenticationResult.Account with PreferredNetwork; its WAM cache enumeration returns cachedAccount.Environment. Microsoft's anonymous instance-discovery response for the public cloud reports PreferredNetwork `login.microsoftonline.com`, PreferredCache `login.windows.net`, and aliases `login.microsoftonline.com`, `login.windows.net`, `login.microsoft.com`, `sts.windows.net`.

The helper's literal environment comparison cannot recognize these equivalent hosts. This is a source-established compatibility defect consistent with the observed cold-success/warm-lookup-failure sequence, although the prior attempt did not retain alias classification. A narrowly scoped correction is being prepared: equivalence only within that fixed official public-cloud set, exact home/tenant/subject checks preserved, and unique-account selection still required. Safe lookup diagnostics will distinguish unique exact versus unique public-alias matches and whether the previous exact selector would have succeeded, allowing the next installed attempt to verify this mechanism without exposing identities.

### Public-cloud alias correction: installed and real refresh verified

The final source resource is `3676458f-ab0c-4151-9a38-ef0ff6d1a867`, 94,841 bytes, SHA256 `7e996c1761b8a394ab1010962e6b10b97a62d124aaeb573666d8966bb1dfaafe`. Leader independently verified the archive and all 42 manifest entries and reviewed the final changes. Member-run offline checks total 173 passing tests, including an actual AuthService cold-network/warm-cache sequence that failed before the correction and passed afterward. The final policy requires both environment hosts to belong to the four official public-cloud aliases; even identical unknown or sovereign-cloud hosts are rejected. Account selection and result validation use the same rule. Home ID, tenant, subject and unique-match checks remain in place; multiple matches are still rejected. There is no extra account probe, token persistence or pairing migration.

The member installed all 478 files with matching hashes, preserving pairing/binding and startup. PID 41144 started at 03:09:28 and retained the existing pause. One explicit Check silently at 03:11:26 succeeded and synchronized, recording `unique_exact`, `oldExactSucceeded=true`, no force call, and expiry 03:55:55. One subsequent Refresh silently in the same process at 03:11:51 succeeded with `unique_public_alias`, `oldExactSucceeded=false`, and force-started/completed both true. Expiry increased to 04:22:22. This directly validates the warm-cache alias mismatch that the previous exact selector would reject, followed by an actual forced silent acquisition and credential upload. It is stronger evidence than a cache hit or an offline force flag test. No Sign in, interactive fallback, re-pairing or repeated authentication loop was used.

Leader independently confirmed D1 revision 13, authorized, no error, synchronized at `1792437113285` (03:11:53.285 +08:00), expiry `1792441342441` (04:22:22.441). A real pinned Opus 5.5 request returned HTTP 200 / `claude-opus-5.5` / `end_turn` with no credential-unavailable error. The helper remains configured for a 15-minute lead and 30–60 second transient retry; the next scheduled natural renewal is approximately 04:07:22 +08:00. The corrected natural timer cycle has not yet been observed, although the shared real forced-acquisition path has now succeeded. No CFW redeployment, commit or push was needed for this Windows correction.

Final installed evidence resource `056fd077-c175-40c5-b358-ce49232e1985` is 26,323 bytes, SHA256 `137deadd199b04bcc9f4537e0d440450e6ea92117ee5abd556418572ce17a0bd`. Leader independently verified its ZIP and all eight manifest entries, read both safe runtime result records, and confirmed that its 478-file publish manifest exactly matches the reviewed source bundle's manifest. The member left PID 41144 in the tray at 03:12:20 with renewal enabled; llm-relay remained unchanged. The historical 02:21 failure has no retained phase detail, so the verified warm-cache failure mechanism is not presented as a complete reconstruction of every historical incident.
