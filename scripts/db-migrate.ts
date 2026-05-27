/**
 * Run Drizzle migrations against the configured DATABASE_URL.
 *
 * Used by:
 *   - Local dev: `pnpm db:migrate` (run once after cloning or after pulling
 *     changes that add new migrations).
 *   - Docker: `migrate` service runs this then exits before app services start.
 *
 * If PostgreSQL is unreachable, postgres-js throws a clear connection error.
 * No separate connectivity check needed here — migration requires DB anyway.
 *
 * Zero external dependencies for the env loader (avoids adding dotenv
 * to the root package).
 */

import { resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// ── Load .env manually (no dotenv dependency) ───────────────────

function findRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const ROOT = findRoot();
const envPath = resolve(ROOT, ".env");

if (existsSync(envPath)) {
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip inline comments outside quoted values
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIndex = value.indexOf(" #");
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
    }
    value = value.replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

// ── Run migration ───────────────────────────────────────────────

async function main(): Promise<void> {
  const { runMigrations } = await import("../packages/core/dist/index.js");
  // eslint-disable-next-line no-console
  console.log("Running database migrations...");
  const { migrationsFolder } = await runMigrations();
  // eslint-disable-next-line no-console
  console.log(`✓ Migrations completed (folder: ${migrationsFolder})`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`\n❌ Migration failed: ${message}`);
  // eslint-disable-next-line no-console
  console.error("   → Ensure PostgreSQL is running: docker compose up -d postgres\n");
  process.exit(1);
});
