-- Task #13 — repairing a database that ran an earlier 0066.
--
-- 0066 first created `purchase_mail_outbox` with a `kind` column and a `locale`
-- column, and was later edited to drop both from its own text. Drizzle decides
-- whether a migration has run from the newest timestamp in the database, so an
-- edited file is never re-applied: a database that ran the earlier version
-- still has both columns, and `locale` is NOT NULL with no default.
--
-- The insert into this table is the last statement of the transaction that
-- grants a purchase's credits. On such a database it violates the not-null
-- constraint, and the whole transaction rolls back — taking the credit lot
-- with it, so a paid purchase grants nothing. The integration suite builds a
-- fresh database from these files every run and is structurally unable to see
-- that, which is why it has to be repaired rather than discovered.
--
-- `IF EXISTS` makes this a no-op on any database created from the current
-- 0066.

ALTER TABLE "purchase_mail_outbox" DROP COLUMN IF EXISTS "kind";--> statement-breakpoint
ALTER TABLE "purchase_mail_outbox" DROP COLUMN IF EXISTS "locale";
