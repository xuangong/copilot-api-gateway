# Repository Guidelines

## Project Structure & Module Organization
Core application code lives in `src/`. Use `src/index.ts` for the Cloudflare Workers entrypoint and `src/local.ts` for local Bun execution. Keep HTTP handlers in `src/routes/`, provider-specific logic in `src/services/`, reusable request/response fixes in `src/transforms/`, and persistence adapters in `src/repo/` and `src/storage/`. Dashboard UI lives in `src/ui/`. Database migrations are in `migrations/`, tests in `tests/`, and utility scripts in `scripts/`.

## Build, Test, and Development Commands
Install dependencies with `bun install`. Use `bun run local:watch` for local development with hot reload, or `bun run dev` to run the Worker through Wrangler on port `4141`. Run `bun run typecheck` before opening a PR. Use `bun run test` for the fast Bun test suite, and `bun run test:integration`, `bun run test:integration:openai`, `bun run test:integration:anthropic`, or `bun run test:integration:gemini` for SDK compatibility checks against a running local server.

## Coding Style & Naming Conventions
This repository uses TypeScript with `strict` mode enabled. Follow the existing style: 2-space indentation, double quotes, no semicolons, and ESM imports. Prefer the `~/*` path alias for internal imports from `src/`. Name route and service modules with kebab-case filenames such as `chat-completions.ts`, and keep exported functions and constants in camelCase or UPPER_SNAKE_CASE. There is no dedicated linter configured, so match the surrounding file style and rely on `bun run typecheck` as the minimum gate.

## Testing Guidelines
Tests use `bun:test`. Place new unit or integration files in `tests/` and follow the existing `*.test.ts` naming pattern, for example `sdk-openai.test.ts`. Keep unit tests focused on transformations, storage, and error handling, and add SDK-level coverage when changing request or streaming behavior. Integration tests expect the gateway to be running locally; use `bun run local` in a separate shell first.

## Commit & Pull Request Guidelines
Recent history follows short, imperative Conventional Commit prefixes such as `feat:`, `docs:`, and `fix:`. Keep commit messages scoped to one change. Pull requests should explain the user-facing impact, list any new environment variables or migration files, and note which commands were run for verification. Include screenshots only when changing the dashboard UI.

## Configuration & Deployment Notes
Prefer Bun-based workflows over `npm` or `pnpm`. Keep secrets out of the repository; use Wrangler secrets for Workers and environment variables such as `ADMIN_KEY`, `LANGSEARCH_API_KEY`, and `TAVILY_API_KEY` for local or Docker runs. When schema changes are required, add a new numbered SQL file under `migrations/` instead of editing an existing migration.
