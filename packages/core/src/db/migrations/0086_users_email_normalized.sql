-- #288: one mailbox is one account. An address is stored trimmed and
-- lower-cased, so `users_email_idx` compares addresses without regard to case,
-- and the CHECK refuses any write that skipped the normalization.
--
-- Existing addresses that would collapse onto one another stop the migration
-- before any row changes: those accounts each own studios, projects and
-- credits, so they are resolved by hand, never merged here. The check covers
-- soft-deleted rows too, because the unique index does.

DO $$
DECLARE
  clashes text;
BEGIN
  SELECT string_agg(normalized, ', ' ORDER BY normalized) INTO clashes
  FROM (
    SELECT lower(btrim(email)) AS normalized
    FROM users
    GROUP BY 1
    HAVING count(*) > 1
  ) AS duplicated;
  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION 'users.email holds addresses that differ only in case or surrounding space: %', clashes;
  END IF;
END $$;--> statement-breakpoint

UPDATE "users" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized" CHECK ("email" = lower(btrim("email")));
