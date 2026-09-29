-- #286: the account's language. Every email is rendered in the recipient's
-- language, so it has to live where a sender can read it. Written at sign-up
-- from the language the request was negotiated in, and changed only when the
-- user switches the interface language. Existing rows take `en`.

ALTER TABLE "users" ADD COLUMN "locale" varchar(10) DEFAULT 'en' NOT NULL;
