# Codex authorized import acceptance

Frozen base: `607b2290f67ce8e7d054cce4ddf9eb3ad13d2d10`. Product hashes are in `product-sha256.json`.

## Delivered and verified

Session-only preview, single-account import, same-account credential replacement and explicit renewable refresh now use the existing authorized upstream control plane and Dashboard. Preview/import do not verify credentials online. Replacement preserves metadata and installation identity and atomically advances catalog generation once; ordinary refresh does not. Private state never enters the public DTO.

- Independent specification/code-quality review: Approved, no task findings.
- Focused tests: 36 pass, including 18 new real temporary-SQLite route tests.
- Clean `bun run ci:local`: 4590 pass, 1 existing skip, 0 fail. Purity, all typechecks, lint (0 errors, 35 inherited warnings), UI build and Workers dry-run pass.
- Actual local workerd app/D1: session/API-key boundaries, preview purity, original indexes, body/row limits, deliberately false Content-Length with reader cancellation, create/reimport identity and generation, account conflict, foreign/missing equivalence, nonrenewable preservation, renewable refresh, proxy failure without fallback and real Request cancellation with late OAuth exclusion pass. The wrong-length stream stops after 17 of 20 planned chunks. Outbound OAuth responses are synthetic Miniflare service responses.
- Actual Chromium/Bun/temporary SQLite: paste/create, invalid row exclusion, selected row, file replacement, preserved metadata/installation, generation increment once, explicit refresh, success/cancel clearing, stale delayed preview after document edit, target unmount clearing, no URL/browser-storage secret, and zero page errors pass. The final screenshot was inspected.

## Evidence boundaries and harness corrections

No production data, credentials, provider login or deployment was used. These are synthetic protocol/authorization/lifecycle results, not proof that a real account is valid or an external provider is available. Prior foundation acceptance plus this full suite covers the unchanged parser row caps, six-provider safe DTOs, metadata-only PATCH and atomic replacement primitives named as cross-task checks by the reviewer.

The initial OAuth fixture omitted id_token and was corrected. A browser probe initially used an exact label query whose accessible name changed when a textarea gained text; the final probe uses its textbox role with a stable name prefix. Initial browser reconnaissance blocked fetch but missed the platform raw-socket discovery path: unrelated /api/models attempted TLS and failed during negotiation. Only synthetic credentials existed. The final accepted fixture explicitly rejects SocketDial, substitutes the unrelated model-list response and uses synthetic OAuth; no live discovery or OAuth result is counted as evidence.

The reproducible scratch scripts and safe result files are included. Browser fixtures bind loopback on a fresh port with a temporary database and stop their own server. Paths in the captured results identify this local run. No new migration or environment variable is introduced by this package; earlier C08/C02 migrations remain prerequisites for deployment.
