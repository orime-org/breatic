-- Influencer attribution (inner#2157). One row per influencer code, seeded with `official`; every account records the
-- code of the site it signed up on, and existing accounts get `official` through the column default.
CREATE TABLE "influencers" (
  "code" varchar(32) PRIMARY KEY,
  "host" varchar(253),
  "disabled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "influencers_code_check" CHECK ("code" ~ '^[a-z0-9-]{1,32}$'),
  CONSTRAINT "influencers_host_check" CHECK ("host" = lower("host"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "influencers_host_idx" ON "influencers" ("host");
--> statement-breakpoint
INSERT INTO "influencers" ("code", "host") VALUES ('official', NULL);
--> statement-breakpoint
CREATE TABLE "influencer_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key" text NOT NULL UNIQUE,
  "request_hash" varchar(64) NOT NULL,
  "requested_by" uuid NOT NULL,
  "request_body" jsonb NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "influencer_operations_key_check" CHECK ("key" ~* '^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT "influencer_operations_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "influencer_operations_body_check" CHECK (jsonb_typeof("request_body") = 'object'),
  CONSTRAINT "influencer_operations_result_check" CHECK (jsonb_typeof("result") = 'object' AND "result"->>'status' IN ('created','applied','refused'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "influencer_code" varchar(32) NOT NULL DEFAULT 'official'
  CONSTRAINT "users_influencer_code_fk" REFERENCES "influencers"("code") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "users_influencer_code_idx" ON "users" ("influencer_code");
