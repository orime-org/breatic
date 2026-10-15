-- Product analytics (inner#1442). `users.consent_seen` is the consent a
-- signed-in browser last reported, read by events no browser is behind;
-- `users.attribution` holds the first-touch and last-touch campaign
-- source written at sign-up; `upload_grants.analytics_consent` carries the
-- uploading browser's consent to the finish paths; `subscriptions.first_active_at`
-- marks the one write that counts as a subscription start. All nullable:
-- rows from before this have no choice on record and send nothing.
-- Statement order: the migrator runs every pending migration in one
-- transaction, so a lock taken here is held until commit. The read-only
-- backfills run first and the ALTERs that take an exclusive lock on users,
-- upload_grants and subscriptions run last.

-- Product milestones reported once (inner#1442 §4.8); the insert is the claim.
CREATE TABLE "analytics_milestones" (
  "key" varchar(255) PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- >>> milestones backfill
-- A collaborator who already acted in a project before this shipped has had
-- their first action, so it is claimed here: their next one is not reported.
-- The actions are those the milestone counts: a Space change, an upload, a
-- generation, or a message in one of the project's Agent conversations.
INSERT INTO "analytics_milestones" ("key")
SELECT 'collab:' || a."project_id" || ':' || a."actor_user_id"
  FROM "project_activities" a JOIN "projects" p ON p."id" = a."project_id"
  WHERE a."actor_user_id" IS NOT NULL AND a."actor_user_id" <> p."created_by_user_id"
    AND (a."type" LIKE 'space:%' OR a."type" = 'asset:uploaded' OR a."type" LIKE 'generation:%')
UNION
SELECT 'collab:' || c."project_id" || ':' || m."user_id"
  FROM "conversation_messages" m
  JOIN "conversations" c ON c."id" = m."conversation_id"
  JOIN "projects" p ON p."id" = c."project_id"
  WHERE m."role" = 'user' AND m."user_id" <> p."created_by_user_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- An account that already finished an Agent turn, completed a generation or
-- created a project before this shipped has had its first; claiming it here
-- keeps its next one from being reported as a first (inner#1442 §4.8). A turn
-- counts when its reply carries none of the marks a failed, stopped or blocked
-- turn leaves; deleted projects and conversations count.
INSERT INTO "analytics_milestones" ("key")
SELECT 'first-agent:' || m."user_id"
  FROM "conversation_messages" m
  WHERE m."role" = 'assistant'
    AND NOT (m."parts" @> '[{"type":"failed"}]' OR m."parts" @> '[{"type":"interrupted"}]'
             OR m."parts" @> '[{"type":"blocked"}]')
UNION
SELECT 'first-generation:' || t."user_id" FROM "tasks" t WHERE t."status" = 'completed'
UNION
SELECT 'first-project:' || p."created_by_user_id" FROM "projects" p
ON CONFLICT DO NOTHING;
-- <<< milestones backfill
--> statement-breakpoint
-- What was reported to the ad platform (inner#1442 §4.9). The key makes one
-- conversion queue once.
CREATE TABLE "ads_conversion_uploads" (
  "conversion" varchar(32) NOT NULL,
  "transaction_id" varchar(255) NOT NULL,
  "payment_id" uuid,
  "status" varchar(16) NOT NULL,
  "job" jsonb NOT NULL,
  "request_id" varchar(128),
  "failure_reason" varchar(32),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ads_conversion_uploads_conversion_transaction_id_pk" PRIMARY KEY ("conversion", "transaction_id"),
  CONSTRAINT "ads_conversion_uploads_status_check"
    CHECK ("status" IN ('queued', 'uploaded', 'failed'))
);--> statement-breakpoint
ALTER TABLE "ads_conversion_uploads" ADD CONSTRAINT "ads_conversion_uploads_payment_id_payments_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ads_conversion_uploads_payment_idx" ON "ads_conversion_uploads" USING btree ("payment_id");--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consent_seen" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "attribution" jsonb;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "analytics_consent" jsonb;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "first_active_at" timestamp with time zone;
--> statement-breakpoint
-- A subscription already on record has started, so its first activation is
-- back-filled: without it the next write to an existing subscription would be
-- reported as a new one. Stripe's `incomplete` and `incomplete_expired` are
-- the only states a subscription can hold without ever having been active.
UPDATE "subscriptions" SET "first_active_at" = "created_at"
  WHERE "status" NOT IN ('incomplete', 'incomplete_expired');
