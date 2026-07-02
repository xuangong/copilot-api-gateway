# Dual smoke root vs vNext

Generated: 2026-06-26T10:29:25.732Z

Root: `http://localhost:41414` · vNext: `http://localhost:41415`

| Case | root status | vNext status | root ms | vNext ms | root bytes | vNext bytes | parity |
|---|---|---|---|---|---|---|---|
| `health` | 200 | 200 | 15 | 12 | 35 | 49 | ✅ |
| `models` | 200 | 200 | 1715 | 2258 | 28703 | 28703 | ✅ |
| `chat:gpt-4o-mini:nonstream` | 200 | 200 | 1807 | 1639 | 1352 | 1382 | ✅ |
| `chat:gpt-4o-mini:stream` | 200 | 200 | 1836 | 966 | 4114 | 4444 | ✅ |
| `chat:claude-haiku-4.5:stream` | 200 | 200 | 2949 | 3198 | 1710 | 1598 | ✅ |
| `chat:gpt-5-mini:stream` | 200 | 200 | 2014 | 3564 | 1817 | 1170 | ✅ |
| `messages:claude-haiku-4.5:stream` | 200 | 200 | 2356 | 1518 | 1922 | 1922 | ✅ |
| `messages:claude-sonnet-4.6:nonstream` | 200 | 200 | 2491 | 1389 | 831 | 298 | ✅ |
| `responses:gpt-5.4:stream` | 200 | 200 | 2030 | 1152 | 9499 | 10117 | ✅ |
| `chat:tools:gpt-4o-mini:stream` | 200 | 200 | 1779 | 919 | 4097 | 4493 | ✅ |
| `error:bogus-model` | 404 | 404 | 817 | 3 | 161 | 58 | ⚠️ both error |
