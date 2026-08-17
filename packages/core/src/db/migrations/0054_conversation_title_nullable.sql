-- A conversation with no name of its own stores no name.
--
-- Until now the column carried the English string 'New conversation' as its
-- default, and that value did double duty: it was both "this has not been
-- named" and a title shown to the reader. Neither job was done properly.
--
-- As a marker it is unreliable — naming a conversation after its first message
-- has to ask "has this been named yet", and the only way to ask that of a
-- string is to compare it against the default, which a person who names their
-- conversation 'New conversation' silently defeats.
--
-- As a title it is untranslated. The product ships five locales and this
-- string has none: a reader in Chinese saw English. What replaces it is a
-- localized placeholder chosen at render time, which is where the reader's
-- language is known — the server has no business deciding it.
--
-- NULL says the one thing that is true: this conversation has no name yet.
-- Every row currently holding the default is one of those, because until this
-- branch no code path anywhere could change a title (`updateTitle` had zero
-- callers), so the value cannot be anyone's deliberate choice.
--
-- Hand-written (drizzle-kit generate needs a TTY here; same pattern as
-- 0018/0025/0026/0049/0052: .sql + _journal entry, no snapshot).

ALTER TABLE "conversations" ALTER COLUMN "title" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "title" DROP NOT NULL;
--> statement-breakpoint
UPDATE "conversations" SET "title" = NULL WHERE "title" = 'New conversation';
