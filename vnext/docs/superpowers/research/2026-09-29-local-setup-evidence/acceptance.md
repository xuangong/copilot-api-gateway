# D10B revision 2 acceptance

The candidate is based on accepted D10A `8f39d0d6dacac78c77ecf2704631fbd3cf7fa734`. `source-manifest.json` identifies all 35 implementation files. Those hashes matched before and after the independent runtime sequence.

- Full `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local`: exit 0; **5110 pass, 1 existing skip, 0 fail, 85950 assertions**. Framework purity, types, lint, UI/setup build and Workers dry-run passed. Lint retains 35 existing warnings and the multiple-tsconfig advisory; it is not warning-free.
- Writer focused regression suite: **95 pass, 0 fail, 512 assertions**, including actual copied POSIX/PowerShell commands and recovery diagnostics. Two display-name-only test changes were followed by 52 passing tests / 349 assertions.
- Independent frozen runtime: all **eight sequential processes passed**: valid-digest contract rejection/redaction, direct CLI, sh wrapper, macOS PowerShell wrapper, failure/recovery probes, Chromium UI, pinned native Codex parser/auth, and workerd/D1 static assets.
- Failure/recovery probes covered 13 cases, including custom homes rejected before exchange, copied-command cancellation and absent Bun, dry-run, malformed configuration, real OS SIGKILL recovery, concurrent-edit preservation and credential helper failures.
- Browser probes verified masked token and redacted preview, token-free command, revoke/remint, stale preview and scoped late mint, assigned-only UI/API refusal, zero lease exchanges/egress and no browser errors. All created leases were revoked. The screenshots show synthetic loopback data only.
- The native Codex source at `8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f` parsed the generated provider and executed the installed auth helper against a loopback HTTP responder. This intentionally substituted HTTP; accepted C12 evidence supplies WebSocket interoperability.

Independent initial review found strict-schema coercion and previous custom-header credential exposure despite initially green checks. Root reproduced both before correction. The revision 2 sequence re-ran the probes expecting rejection/redaction. Independent scoped re-review approved revision 2: I1/I2/M1/M2 addressed, no new Critical/Important findings. Root also verified asset freshness, all-file whitespace, and evidence-script lint.

No production client home, credential, service or database was modified. Native Windows, remote CI, Docker image construction and deployment remain outside this acceptance. No push or deployment was performed.
