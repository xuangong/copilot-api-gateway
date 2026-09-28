# D08 legacy detail exact-key filter acceptance (2026-09-29)

The two-file correction on `9fd40412` passed independent spec/quality review. Root clean `bun run ci:local`: 4192 passed, 1 existing skip, 0 failed, all type/purity/lint (36 inherited warnings), Dashboard build and Workers dry-run gates passed. Focused real-SQL route/repo/overview/shared checks: 43 passed, 208 assertions.

The ordinary-session detail route previously ignored `key_id` and returned all owned+assigned rows. Supplying both repo keyId/keyIds would still be wrong because the old query helper gives the set precedence. The corrected route validates membership and then queries just the selected key; no-filter behavior remains the full authorized set. Existing API-key scope precedes session/admin/shared flags and cannot be redirected by a query parameter; admin historical orphan rows remain accessible within admin scope.

Root independent real Bun Gateway + SQLite HTTP fixture confirmed selected owned=5 requests, selected assigned=11, empty=0, no filter=16 and foreign=0. The fixture process was stopped. The actual app regression test uses real users/sessions/keys/assignments and covers authentication, membership and historical admin rows. No database responses are mocked, and no production data was used.

The existing legacy shared-view branch now resolves only owner-scoped HMAC key references. Its regression injects shared auth flags into a standalone router with real SQLite. The legacy app path still does not resolve `as_user`; this evidence does not claim otherwise. Overview uses its independently verified grant resolver. No cross-owner exposure was established by the old detail filter defect.

Reproduce product coverage with `bun test packages/gateway/tests/control-plane-token-usage-key-filter.test.ts` from vNext, plus the recorded related suites. The earlier quota-browser evidence remains a historical pre-fix capture at `9fd40412`; its assertion of 16 selected-key detail requests deliberately records the old discrepancy and is expected to fail on this corrected endpoint. The new HTTP result is 5. Quota UI continues using overview unchanged.
