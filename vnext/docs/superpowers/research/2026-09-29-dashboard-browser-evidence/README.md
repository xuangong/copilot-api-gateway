# D01/D04 isolated Dashboard browser evidence

Verified 2026-09-29 on clean committed `bcac1e4d`, with its successful `ci:local` UI build. The server used the actual Gateway app and Bun platform bootstrap, a new temporary SQLite database and dump directory, synthetic admin/session/key/upstream records, and ephemeral `127.0.0.1` listeners. Environment was cleared before launch except PATH/HOME. Existing Docker services, databases and CLI configurations were not accessed or changed.

The existing Node Playwright installation and cached headless Chromium were used because Python Playwright was not installed. [Fixture](fixture.ts.txt) and [browser assertions](validate.mjs.txt) are retained as text evidence, with local dependency paths explicit. They run entirely against synthetic state. The fixture provider responds only on loopback; proxy probes were intercepted by Playwright with controlled synthetic replies, so this is UI race verification, not a real proxy-network test.

- **D01:** Compared the supported manual entry (`id`, `name`, `ownedBy`) and separate `upstreamModelId`/`cost` entry before editing, after a real successful PATCH, and after reopening the editor. All values remained equal. [Editor screenshot](d01-model-roundtrip.png).
- **D04:** Held a proxy-test response, edited the host, then delivered the old successful result; its IP never appeared. A subsequent current-draft success appeared and was removed when the host changed again. [Cleared-feedback screenshot](d04-stale-proxy-result.png).
- Both runs used actual rendered components; the browser reported no page JavaScript errors.

An exploratory fixture included unsupported pre-C04 `chat`, `context_length` and `pricing` fields on an `id` entry; normalization discarded those fields as its then-current schema specified. The D01 acceptance fixture was corrected to supported fields before the passing run. C04 independently owns validated chat-metadata support; this report does not claim arbitrary unknown fields round-trip.

Reproduction: create a fresh private temporary directory, copy `fixture.ts.txt` as `fixture.ts` and `validate.mjs.txt` as `validate.mjs`; build the referenced clean checkout UI first; launch Bun from the temporary directory with a cleared environment, wait for `connection.json`, then run the browser script with Node. Close the dedicated server afterward. The paths in these evidence scripts must be adjusted if the checkout or existing Playwright installation moves.
