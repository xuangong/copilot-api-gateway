# Dual smoke root vs vNext

Generated: 2026-06-26T16:43:59.732Z

Root: `http://localhost:41414` · vNext: `http://localhost:41415`

| Case | root status | vNext status | root ms | vNext ms | root bytes | vNext bytes | parity |
|---|---|---|---|---|---|---|---|
| `health` | 200 | 200 | 25 | 22 | 35 | 49 | ✅ |
| `models` | 200 | 200 | 5501 | 862 | 28699 | 28699 | ✅ |
| `chat:gpt-4o-mini:nonstream` | 200 | 200 | 1841 | 959 | 1366 | 1375 | ✅ |
| `chat:gpt-4o-mini:stream` | 200 | 200 | 1799 | 961 | 4522 | 4885 | ✅ |
| `chat:claude-haiku-4.5:stream` | 200 | 200 | 4029 | 1741 | 1512 | 1598 | ✅ |
| `chat:gpt-5-mini:stream` | 200 | 200 | 3105 | 1029 | 1808 | 1170 | ✅ |
| `messages:claude-haiku-4.5:stream` | 200 | 200 | 2323 | 1436 | 2027 | 1922 | ✅ |
| `messages:claude-sonnet-4.6:nonstream` | 200 | 200 | 2051 | 1195 | 831 | 298 | ✅ |
| `responses:gpt-5.4:stream` | 200 | 200 | 3105 | 1146 | 10117 | 9499 | ✅ |
| `chat:tools:gpt-4o-mini:stream` | 200 | 200 | 1737 | 915 | 4097 | 4493 | ✅ |
| `error:bogus-model` | 404 | 404 | 835 | 2 | 161 | 58 | ⚠️ both error |
