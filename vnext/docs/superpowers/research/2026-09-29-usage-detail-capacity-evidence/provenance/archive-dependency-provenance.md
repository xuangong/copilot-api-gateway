# D08 original-source archive: copied dependency provenance

Status: **dependency provenance audit**. This audit used file and lock inspection; the root agent subsequently built the dashboard assets and started the separate oracle runner. This record does not establish JSON parity or D08 repair acceptance.

The product source was archived from commit `8f39d0d6dacac78c77ecf2704631fbd3cf7fa734`. Its `vnext/bun.lock` SHA-256 is `d11bd35f35dd46125851c77f92e9948089adfc30ce16091306c345cc7d675ffe`. The frozen archive install could not be completed in this environment, so the root agent copied installed `node_modules` trees from `reference-adoption-verify` at HEAD `cce086c355521ba99bd6aad3429d85b99ec66910` into the archive, preserving relative symlinks. The verify lock SHA-256 is `07519569bb27f4263158599ef1f8450b2b8b86396bb838663bbfdccdcaa5e411`. This is an **inherited installed dependency copy**, not a successful `bun install --frozen-lockfile` in the archive.

The [copy manifest](d08-acceptance/archive-dependency-copy.json) records the 21 copied root and workspace-local `node_modules` directories and all 1,571 symlinks. Its validator resolved every link under the archived `vnext` tree, so the copied workspace links cannot import mutable product source from the verify checkout. All 88 `@vibe-*` workspace links resolve to existing targets inside the archive. The 27 dangling links are old `@vnext` (22) and `@vnext-llm` (5) aliases to absent package names; a source scan of the archived `apps/` and `packages/` found no `@vnext` imports. They remain in the copied modules, and this static scan does not establish every possible dynamic import path.

The [machine-readable lock audit](d08-acceptance/archive-dependency-lock-audit.json) compares installed package manifests with the archived lock and hashes the corresponding `package.json` files against the verify source of the copy:

| Check | Result |
| --- | --- |
| Archive versus verify lock package entries | 521 versus 522; the only package/workspace delta is verify's added `@vibe-llm/setup-local`. All nonworkspace lock entries are identical. |
| Installed `.bun` package manifests | 1,264 occurrences, 413 unique name/version pairs. |
| Installed pair outside archived lock | `uplot@1.6.32` only; it is an extra copied package absent from the old lock. Archived product source contains no `uplot` import in the static scan. |
| Installed `package.json` hash mismatch against verify copy source | 0 of 1,264 occurrences. |
| Archived locked pairs not observed installed | 77; examples include other-platform workerd/esbuild packages. Their absence is recorded individually in the JSON and has not been classified as harmless one by one. |

These checks support a narrower claim: the copied observed nonworkspace package versions, apart from the extra `uplot`, agree with the old lock, and copied product-workspace links point back into old archived source. They do not hash every dependency file, prove that all locked packages are present, prove the dependency state at the original baseline timestamp, or make the new oracle a byte-for-byte replay of the first run.

The root agent's subsequent archived-source `build:ui` completed (`/tmp/vnext-d08-original-build-copy.log`). Its generated `dashboard.js.txt` SHA-256 is `78d2ff14887c06f49fc866b13bd4375b0b091483ae97ef1b7bcd8b82451b64e0`; `dashboard.css.txt` is `303b28c246a5428d6cbf54f767f1610163c4803a1bfb9c819d4becb7127adeb7`. Those artifacts are generated from old archived source using the copied current installed dependencies. Their hashes establish the files used by the new oracle, not their contents or dependency state during the original baseline run.
