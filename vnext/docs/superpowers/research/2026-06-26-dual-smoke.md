# Dual smoke root vs vNext

Generated: 2026-06-26T10:16:31.044Z

Root: `http://localhost:41414` · vNext: `http://localhost:41415`

| Case | root status | vNext status | root ms | vNext ms | root bytes | vNext bytes | parity |
|---|---|---|---|---|---|---|---|
| `health` | 200 | 200 | 16 | 14 | 35 | 49 | ✅ |
| `models` | 200 | 200 | 852 | 5 | 28703 | 28703 | ✅ |
| `chat:gpt-4o-mini:nonstream` | 200 | 200 | 1815 | 952 | 1347 | 1369 | ✅ |
| `chat:gpt-4o-mini:stream` | 200 | 200 | 1946 | 992 | 4522 | 4885 | ✅ |
| `chat:claude-haiku-4.5:stream` | 200 | 200 | 2753 | 1984 | 1512 | 1988 | ✅ |
| `chat:gpt-5-mini:stream` | 200 | 200 | 1922 | 983 | 1796 | 1162 | ✅ |
| `messages:claude-haiku-4.5:stream` | 200 | 200 | 2417 | 1389 | 2027 | 1922 | ✅ |
| `messages:claude-sonnet-4.6:nonstream` | 200 | 200 | 2413 | 7892 | 851 | 293 | ✅ |
| `responses:gpt-5.4:stream` | 200 | 200 | 1996 | 981 | 10117 | 10117 | ✅ |
| `chat:tools:gpt-4o-mini:stream` | 200 | 200 | 1782 | 950 | 4097 | 4493 | ✅ |
| `error:bogus-model` | 404 | 404 | 846 | 3 | 161 | 58 | ⚠️ both error |
