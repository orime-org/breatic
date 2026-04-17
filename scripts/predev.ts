/**
 * Pre-development check: verify PG + Redis are online, then run migration.
 *
 * Used by:
 *   - Local dev: turbo runs this before starting services
 *   - Docker: migrate service runs this then exits
 *   - Manual: pnpm db:migrate
 *
 * Zero external dependencies — uses only Node.js built-ins + @breatic/core.
 * Exits 0 on success, 1 on failure with clear error message.
 */

import { createConnection } from "node:net";
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
    // Strip inline comments (but not inside quotes)
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIndex = value.indexOf(" #");
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
    }
    value = value.replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

// ── TCP connectivity check ──────────────────────────────────────

function checkTcp(host: string, port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port, timeout: 3000 });
    socket.on("connect", () => { socket.destroy(); resolve(); });
    socket.on("timeout", () => { socket.destroy(); reject(new Error(`${label} not reachable at ${host}:${port}`)); });
    socket.on("error", (err) => { reject(new Error(`${label} not reachable at ${host}:${port} — ${err.message}`)); });
  });
}

function parseUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || (u.protocol === "redis:" ? 6379 : 5432) };
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "postgres://localhost:5432/breatic";
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379/0";

  const db = parseUrl(dbUrl);
  const redis = parseUrl(redisUrl);

  console.log("Checking infrastructure...");

  // Check PG
  try {
    await checkTcp(db.host, db.port, "PostgreSQL");
    console.log(`  OK  PostgreSQL (${db.host}:${db.port})`);
  } catch (err) {
    console.error(`\n  FAIL  ${(err as Error).message}`);
    console.error("\n  Please run: docker compose up -d postgres redis\n");
    process.exit(1);
  }

  // Check Redis
  try {
    await checkTcp(redis.host, redis.port, "Redis");
    console.log(`  OK  Redis (${redis.host}:${redis.port})`);
  } catch (err) {
    console.error(`\n  FAIL  ${(err as Error).message}`);
    console.error("\n  Please run: docker compose up -d postgres redis\n");
    process.exit(1);
  }

  // Run migration
  console.log("Running database migrations...");
  const { runMigrations } = await import("../packages/core/dist/index.js");
  await runMigrations();
  console.log("  OK  Migrations complete\n");
}

main().catch((err) => {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
});
