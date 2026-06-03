import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Independent Drizzle config for the SEPARATE Yjs document store database.
// Points at the yjs-only schema + its own migrations dir + its own ledger,
// driven by YJS_DATABASE_URL — kept apart from the business config so the
// two databases never share a `__drizzle_migrations` journal.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/yjs-schema.ts",
  out: "./src/db/migrations-yjs",
  dbCredentials: {
    url:
      process.env["YJS_DATABASE_URL"] ??
      "postgres://breatic:breatic@localhost:5432/breatic_yjs",
  },
});
