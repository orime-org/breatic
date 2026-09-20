/**
 * Answers whether the databases have run the migrations this checkout added.
 *
 * The smoke suite runs this before it starts a browser. A migration that
 * arrived with a merge and was never applied shows up much later and much
 * less clearly: an endpoint answers 500, the log says `column "xxx" does not
 * exist`, and the cases that touch it go red as though the product were
 * broken. One measured instance cost a whole round of upload smoke, spent
 * suspecting the model key and the ingest Worker.
 *
 * The question asked here is drizzle's own: it takes the highest timestamp
 * `drizzle.__drizzle_migrations` holds as a watermark and runs every journal
 * entry above it. So a journal entry above the watermark is exactly a
 * migration the next `pnpm db:migrate` would run — which is to say, one this
 * database has not run yet.
 *
 * Two things this deliberately does not ask.
 *
 * A `git diff` answers a different question: roll a migration back and the
 * `.sql` file sits there unchanged.
 *
 * Comparing file hashes answers a different question too, and the difference
 * is easy to miss. A hash the ledger does not hold means the file changed
 * since it ran, not that it never ran — measured on this checkout, four
 * entries had hashes nobody recorded while their tables were present and
 * complete, `project_memories` down to the column a later migration added.
 * Anything below the watermark is history, and `pnpm db:journal-repair` is
 * what reads it.
 *
 * There are two ledgers. The Yjs document store is a separate database with
 * its own journal, so a run that checked only the business one would call a
 * half-migrated machine ready.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { findRoot, loadEnv } from "./load-env.js";

const ROOT = findRoot();
loadEnv(ROOT);

/** One database's migrations: where its journal is and how to reach it. */
interface Ledger {
  /** What to call it when something is missing. */
  readonly name: string;
  /** The migrations folder, relative to the repo root. */
  readonly folder: string;
  /** Which environment variable holds its connection string. */
  readonly url: string;
}

const LEDGERS: readonly Ledger[] = [
  {
    name: "business",
    folder: "packages/core/src/db/migrations",
    url: "DATABASE_URL",
  },
  {
    name: "yjs",
    folder: "packages/core/src/db/migrations-yjs",
    url: "YJS_DATABASE_URL",
  },
];

/**
 * Reads the timestamps a folder's journal declares.
 * @param folder - The migrations folder, relative to the repo root.
 * @returns Each entry's tag and timestamp, in journal order.
 * @throws {Error} When the journal cannot be read.
 */
function declared(folder: string): { tag: string; when: number }[] {
  const path = resolve(ROOT, folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf-8")) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries;
}

/**
 * Asks one database which migrations the next migrate run would apply.
 * @param ledger - Which database to ask.
 * @param createPgClient - Core's client factory.
 * @returns The tags above that database's watermark, in journal order.
 * @throws {Error} When the database cannot be reached.
 */
async function aboveWatermark(
  ledger: Ledger,
  createPgClient: (url: string, opts: { name: string }) => {
    unsafe: (sql: string) => Promise<{ created_at: string }[]>;
    end: () => Promise<void>;
  },
): Promise<string[]> {
  const url = process.env[ledger.url];
  if (url === undefined || url === "") {
    throw new Error(`${ledger.url} is not set`);
  }
  const client = createPgClient(url, { name: "smoke-watermark-check" });
  try {
    // A database nothing has migrated has no ledger at all: the table is the
    // migrator's own, created the first time it runs. Reading that as a
    // watermark of zero puts every migration above it, which is the same
    // answer — and the same remedy — as a database that is merely behind.
    const rows = await client
      .unsafe("SELECT created_at::text FROM drizzle.__drizzle_migrations")
      .catch((err: unknown) => {
        if (String(err).includes("does not exist")) return [];
        throw err;
      });
    const watermark = rows.reduce(
      (highest, row) => Math.max(highest, Number(row.created_at)),
      0,
    );
    return declared(ledger.folder)
      .filter((entry) => entry.when > watermark)
      .map((entry) => entry.tag);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const { initCore, createPgClient } = (await import(
    "../packages/core/dist/index.js"
  )) as {
    initCore: (env: NodeJS.ProcessEnv) => void;
    createPgClient: Parameters<typeof aboveWatermark>[1];
  };
  initCore(process.env);

  const pending: string[] = [];
  const unreachable: string[] = [];
  // Both ledgers are asked before anything is reported: one database being
  // unreachable says nothing about the other, and a developer fixing them one
  // message at a time runs this twice to learn what a single run knows.
  for (const ledger of LEDGERS) {
    try {
      const waiting = await aboveWatermark(ledger, createPgClient);
      if (waiting.length > 0) {
        pending.push(`${ledger.name}: ${waiting.join(", ")}`);
      }
    } catch (err) {
      unreachable.push(
        `${ledger.name} (${ledger.url}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (unreachable.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\n❌ Could not read the migration ledger.\n   ${unreachable.join("\n   ")}\n\n   This is the environment, not the code: check PostgreSQL is running (docker compose up -d postgres) and that .env names both databases.\n`,
    );
    process.exit(1);
  }

  if (pending.length === 0) return;

  // eslint-disable-next-line no-console
  console.error(
    `\n❌ The database has migrations waiting.\n   ${pending.join("\n   ")}\n\n   This is the environment, not the code. Run \`pnpm db:migrate\` from the repo root, then start again.\n`,
  );
  process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(
    `\n❌ Could not read the migration ledger: ${message}\n   This is the environment, not the code: check PostgreSQL is running (docker compose up -d postgres) and that .env names both databases.\n`,
  );
  process.exit(1);
});
