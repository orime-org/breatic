-- #288: one mailbox is one account. An address is stored trimmed and
-- lower-cased, so `users_email_idx` compares addresses without regard to case,
-- and the CHECK refuses any write that skipped the normalization.
--
-- Existing addresses that collapse onto one another are refused by
-- `users_email_idx` itself: the UPDATE fails with a unique violation whose
-- detail names the address, and the migration's transaction leaves every row
-- as it was. Those accounts each own studios, projects and credits, so they
-- are resolved by hand, never merged here. The index covers soft-deleted rows
-- too. To list every collision at once:
--
--   SELECT lower(btrim(email)) AS address, count(*) FROM users
--   GROUP BY 1 HAVING count(*) > 1 ORDER BY 1;

UPDATE "users" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized" CHECK ("email" = lower(btrim("email")));
