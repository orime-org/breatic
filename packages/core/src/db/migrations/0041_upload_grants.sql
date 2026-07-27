-- Upload-grant ledger (#1826, design §2.2 / §3.2): the anti-spoof authority
-- that REPLACES the prefix-based isOwnedKey once storage keys drop their
-- {userId}/{projectId}/ prefix. /presign writes one grant row per issued
-- storage key K (user + owner studio + declared content_hash + K); the upload
-- endpoints re-check it — /local-upload finds a LIVE (not-consumed) grant to
-- gate the disk write WITHOUT consuming (a local upload is a two-hop
-- PUT-then-report on ONE grant), /uploaded finds + INSERTs studio_assets +
-- marks consumed exactly once (anti-replay).
--
-- No expires_at (design v11): the check is ownership + not-consumed only, no
-- upload time limit. No deleted_at: a short-lived anti-spoof credential, not a
-- project-scoped audit row — bound to (user, studio), never to a project,
-- physically reclaimed by an OFFLINE GC sweep (design §7), like an outbox. No
-- updated_at: append-only; consumed_at is a single-shot business marker.
--
-- Hand-written (same pattern as 0034/0040: .sql + _journal entry, no
-- snapshot). Pre-launch, empty DB — no backfill.

CREATE TABLE IF NOT EXISTS "upload_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"studio_id" uuid NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"storage_key" text NOT NULL,
	"declared_size" bigint NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "upload_grants" ADD CONSTRAINT "upload_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "upload_grants" ADD CONSTRAINT "upload_grants_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- A storage key is issued at most once; this UNIQUE both enforces that and
-- serves the ownership lookup (WHERE storage_key = ? AND user_id = ? AND
-- consumed_at IS NULL — storage_key alone locates the row). studio_id is READ
-- from the row, NEVER a query condition: that is the anti-spoof invariant, and
-- it is what lets /local-upload (which holds no studio) authorize a write.
CREATE UNIQUE INDEX IF NOT EXISTS "upload_grants_storage_key_unique" ON "upload_grants" ("storage_key");
