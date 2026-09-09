-- Task #173 — what the grant has to hold once the ingest Worker reports the
-- upload instead of the browser.
--
-- The grant is the only row that survives between signing a ticket and hearing
-- back, so every piece of context the report handler needs travels on it: the
-- browser uploads that context when it asks for the ticket, the server checks
-- it against the user's access, and from then on it is ours rather than the
-- client's.
--
-- Two of these columns are load bearing beyond that:
--
--   `lease_gen` is the fencing generation the report path publishes its event
--   with. Reading it off a row we wrote means the gen never comes from the
--   caller; an event without the right gen is dropped by collab's CAS and the
--   node hangs in handling for an hour.
--
--   `content_hash` goes away. It held a hash the client claimed; the ledger key
--   is now the one the Worker computes over the bytes that really landed, and a
--   column nobody reads is a column someone will read by mistake.
--
-- The new NOT NULL columns are added with a default so existing rows keep their
-- meaning, then the defaults are dropped: a grant issued before this migration
-- has no lease of its own, and zero is a generation no node's fencing counter
-- ever holds (`node-factory.ts` starts at 1), so an event carrying it could
-- only ever be discarded — which is the right outcome for a grant nobody will
-- report on.

ALTER TABLE "upload_grants" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "expires_at" timestamp with time zone NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "lease_gen" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "tool_name" text;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "derived" boolean;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "filename" text;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD CONSTRAINT "upload_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Every future row supplies its own value; the defaults exist only to carry the
-- rows that predate this migration.
ALTER TABLE "upload_grants" ALTER COLUMN "expires_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "upload_grants" ALTER COLUMN "lease_gen" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "upload_grants" DROP COLUMN IF EXISTS "content_hash";--> statement-breakpoint

-- A video names the cover the worker extracted for it. Nullable, and null for
-- every other kind: the video row is written when the report arrives, the cover
-- does not exist until the worker finishes, and between the two this reads as
-- "no cover" — the same state an extraction failure leaves behind.
--
-- RESTRICT rather than SET NULL: a cover that some video points at is not a row
-- anything may quietly drop. Assets are non-deletable today, so this constraint
-- has nothing to refuse yet; it is here so that when deletion arrives, dropping
-- a cover out from under its video fails loudly instead of leaving the video
-- silently coverless.
ALTER TABLE "studio_assets" ADD COLUMN "cover_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "studio_assets" ADD CONSTRAINT "studio_assets_cover_asset_id_studio_assets_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."studio_assets"("id") ON DELETE restrict ON UPDATE no action;
