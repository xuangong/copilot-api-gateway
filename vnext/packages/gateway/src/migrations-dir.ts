/**
 * Single source of truth for the SQL migration corpus. Wrangler reads the same
 * directory via `migrations_dir` in wrangler.jsonc; the Bun runtime resolves it
 * through this URL so both paths apply identical files in identical order.
 */
export const migrationsDir = new URL("../migrations/", import.meta.url)
