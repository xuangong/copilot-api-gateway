# D05 upstream duplicate acceptance (2026-09-29)

An isolated real Bun Gateway, SQLite database, and Chromium browser exercised the own-owner Duplicate action. The final nine-file source delta on base `4449d6a2` passed independent specification/quality review (including two scoped fix reviews), required clean-tree `bun run ci:local` (4114 pass, 1 existing skip, 0 fail; types, purity, lint with 36 inherited warnings, UI build, Workers dry-run), and final browser acceptance. The final browser result is in `browser-result.json`.

The fixture creates synthetic Custom, Azure, SDF, and foreign-owner rows. Custom model display metadata and the separate `{ upstreamModelId, cost }` pricing entry use the actual persistence schema; pricing covers all six billing dimensions. No real credentials, production database, paid inference, Docker service, or live CLI configuration is involved. The loopback listener is stopped by the runner.

Assertions cover the real GET response, draft content and edit isolation, POST rather than source PATCH, new ID and owner, nested reasoning budget and pricing, feature flags, disabled models, proxy fallback order, reload persistence, foreign-owner rejection, and fresh Azure/SDF credential requirements. No browser JavaScript error occurred in the initial successful acceptance run.

## Copy limits

Only Custom, Azure, and SDF rows editable by the current owner expose Duplicate. Copilot OAuth identity is excluded. Credentials, runtime state and record identity are cleared. Recognized credential-bearing URL userinfo/query parameters are removed while ordinary query parameters are retained. Arbitrary default headers are not copied; the form explicitly explains that required headers must be configured separately and cannot be restored in this form. Duplication does not promise identical behavior before that configuration.

The list serializer retains only valid numeric Custom model reasoning budget metadata at its supported path; other sensitive fields remain redacted. A real SQLite route test covers POST → GET → draft → POST and compares stored source and clone.

## Reproduction

The archived scripts are text artifacts; copy them into a scratch directory with their original names and set `D05_SOURCE_ROOT` to a built vNext checkout. Run `run.sh acceptance`. The fixture uses the locally installed Node Playwright and creates its own temporary run directory. The initial attempt was corrected to use the provider's separate cost entry rather than unsupported pricing on a display model; that was a fixture correction.

These checks demonstrate local UI/control-plane behavior with synthetic data. No deployment or real provider compatibility is claimed.
