---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## SDK Integration Testing Methodology

This project is an API proxy that must be fully compatible with multiple AI SDK clients. Integration tests ensure SDK compatibility by adapting test cases from the official SDK repositories.

### Test Sources

| SDK | Official Repository | Test Directory |
|-----|---------------------|----------------|
| Anthropic | https://github.com/anthropics/anthropic-sdk-typescript | `tests/api-resources/`, `tests/api-resources/MessageStream.test.ts` |
| OpenAI | https://github.com/openai/openai-node | `tests/api-resources/`, `tests/streaming.test.ts` |
| Gemini | https://github.com/googleapis/js-genai | `test/unit/`, `test/system/node/` |

### How to Add/Update SDK Tests

1. **Find official SDK tests**: Navigate to the SDK's GitHub repository test directory
2. **Identify key test scenarios**: Focus on:
   - Required params vs full params
   - Streaming behavior and event types
   - Tool/function calling
   - Multi-turn conversations
   - Response structure validation
3. **Adapt tests**: Convert official tests to work with our proxy:
   - Use `TEST_API_BASE_URL` environment variable
   - Use placeholder API keys (proxy handles auth)
   - Add appropriate timeouts for real API calls
4. **Add reference comments**: Document which official test each case is adapted from

### Test Categories

Each SDK test file should cover:

- **Basic API calls**: Minimal params, full params
- **Streaming**: Event types, chunk structure, text accumulation
- **Tool/Function calling**: Tool definitions, tool_choice, tool responses
- **Multi-turn**: Conversation history handling
- **Response validation**: Required fields, correct types, valid enum values

### Running Tests

```bash
# Start local server first
bun run local

# Run all integration tests
bun run test:integration

# Run specific SDK tests
bun run test:integration:anthropic
bun run test:integration:openai
bun run test:integration:gemini
```

### Test File Structure

```
tests/
├── sdk-anthropic.test.ts    # @anthropic-ai/sdk compatibility
├── sdk-openai.test.ts       # openai SDK compatibility
├── sdk-gemini.test.ts       # @google/genai SDK compatibility
└── sdk-web-search.test.ts   # Web search feature tests
```
