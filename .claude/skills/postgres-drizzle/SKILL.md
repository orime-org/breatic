---
name: postgres-drizzle
description: Use before writing or reviewing SQL, Drizzle queries, row locks or transactions in any breatic package (server, domain, collab, core); before writing a concurrency or constraint integration test; before writing a paginated query; and before adding, renumbering or repairing a migration or its journal entry under packages/core/src/db.
---

# PostgreSQL and Drizzle

The rules for where schema, migrations and repos live are in [packages/core/AGENTS.md#database](../../../packages/core/AGENTS.md#database); read it before touching `schema.ts` or a migration. This skill holds the query, locking and migration traps.

## Row locks

**Never put a column that a concurrent writer changes into the `WHERE` of a `SELECT … FOR UPDATE`.** Under READ COMMITTED, PostgreSQL re-checks the `WHERE` against the updated row after waiting for the lock, skips the row if it no longer matches, and does not rescan. `WHERE role = 'admin' … FOR UPDATE` therefore returns nothing at exactly the moment an admin is handed over.

| In the lock condition | Safe |
|---|---|
| `id`, `studio_id`, `project_id`, `user_id` | Yes: concurrent writers never change them |
| `deleted_at IS NULL` | Yes: failing the re-check is the correct answer |
| Any status or role column | No |

**A count invariant ("exactly one admin", "one owner") needs the whole set locked.** A row lock cannot protect "how many rows satisfy X": lock every row of the set with a condition on immutable columns and find the one you need in the returned rows, which also fixes the lock order within the table. Wrapping an unlocked read in a transaction protects nothing; that read can use another connection.

Check: does any column in this lock's `WHERE` belong to what the concurrent side changes? Yes → lock the whole set.

**Before adding a second lock to a transaction, list the locks it will cover while held.** A strong lock taken first makes a weaker lock behind it impossible to contend, and its code, comment and test all keep claiming it works. Place each lock around exactly the window it protects (a Project row lock only around the create branch, an advisory lock around "check empty, then create"), so each one has an observation point of its own.

Check: which existing locks does the new one cover, and does a test still prove each of them does work?

## Concurrency tests

**`Promise.all` over two short transactions does not run them concurrently.** The first finishes and returns its connection to the pool before the second asks for one, so both run serially on one connection and the test passes with the lock deleted.

**Build the interleaving with `waitUntilBlockedOn` from `packages/server/src/__tests__/integration/lock-probe.ts`:**

1. From a separate connection, hold the row with `SELECT … FOR UPDATE`.
2. Start the call under test.
3. `await waitUntilBlockedOn(sql, ['<table>', 'for update'], <n>)`, which polls `pg_stat_activity` until `n` backends are parked on a statement containing every substring.
4. Release the gate and assert.

Pass the number of parties you expect: with the default of one, a second call is satisfied by the first party already waiting. Pass enough substrings to tell the locking statement apart from other statements on the same table (an `UPDATE conversations SET updated_at` also contains `conversations`).

Check: with `.for('update')` deleted, does the test fail at the probe ("only fewer than N backend(s) ever blocked …")? Still green → it is not testing concurrency.

**Integration tests run in one process (`singleFork` in `packages/server/vitest.integration.config.ts`).** A test that drops a constraint, writes, and reinstalls it has no concurrent writer inside that window.

**`pg_get_constraintdef` returns `NOT VALID` from the second read onwards.** A helper that reads the definition and appends ` NOT VALID` before reinstalling builds `… NOT VALID NOT VALID`, which PostgreSQL accepts, so the test stays green by accident. Strip the trailing `NOT VALID` before appending it. Reinstalling with `NOT VALID` is required (the test's bad rows are still in the table), and it still checks new writes.

## Writing queries

**Cast a numeric position for `substring` to `::int`.** In `substring(col from ${n})` the driver binds the number as text, PostgreSQL picks the regular-expression overload, and the result is `NULL`. Only a real-database integration test catches it.

**Pass jsonb values with `sql.json()` (`tx.json()` inside a transaction) and no `::jsonb` cast.**

```ts
sql`INSERT INTO t (col) VALUES (${JSON.stringify(arr)}::jsonb)`   // wrong: stores a JSON string scalar
sql`INSERT INTO t (col) VALUES (${sql.json(arr)})`                 // right
```

The mistake surfaces only on read, as `cannot extract elements from a scalar`. `SELECT jsonb_typeof(col)` must say `array` or `object`, never `string`.

**An ignored `tx` parameter, or a discarded result of a conditional `UPDATE`, is an atomicity hole.** Treat both as review red flags: the call runs outside the transaction, or a lost compare-and-set goes unnoticed. Verify the fix with a real-database integration test.

**Before landing a paginated query, run `EXPLAIN ANALYZE` on the first page and on a late page and compare the rows read.** A cursor applied in `HAVING` filters after grouping, so every page reads and groups every matching row; the plan shows it as a large `Rows Removed by Filter`. Trim the rows from the cursor with an index first, then group that slice. A query of the same shape already in the repository is not evidence that it scales.

Check: does page 100 read as many rows as page 1?

## Migrations

Migrations are hand-written `NNNN_name.sql` files in `packages/core/src/db/migrations/` (the Yjs store has its own in `migrations-yjs/`), each registered with `pnpm db:journal-add <tag>` (`--yjs` for the Yjs journal).

**When two branches claim the same migration number, the one that merges second renumbers.** The first one is on `main` and may already have run on other databases. Renumbering changes three things together: `git mv` the `.sql` file, change `idx` and `tag` in the journal, and search the repository for the old number in comments, tests and docs.

**A migration whose `when` is lower than the newest one your database has run never runs locally, and `pnpm db:migrate` still reports success.** `drizzle-orm@0.45.2` reads only the newest `created_at` in `drizzle.__drizzle_migrations` and runs the journal entries above it. CI and production start from an empty database and are unaffected; a long-lived local database is not. The symptom is a missing table or column while migrate says there is nothing to do.

**After merging `main`, check for such entries with `pnpm db:journal-repair` (it reports by default) and fix them with `pnpm db:journal-repair --apply`.** `pnpm db:check-watermark` only sees entries above the mark, so it cannot see these. Renumbering itself does not re-run a migration that already ran: `when` is unchanged and the file name is not compared.

**If renumbering re-registered your own entry with `pnpm db:journal-add`, its `when` changed; update your local row before repairing.**

```sql
UPDATE drizzle.__drizzle_migrations SET created_at = <new when> WHERE created_at = <old when>;
```

Run the report again, confirm only the other branch's migration is listed, then `--apply`. Without this, the repair re-runs your migration and fails on its own `ALTER`.

Check: does the batch I merged contain a migration whose `when` is below the last one my database ran?
