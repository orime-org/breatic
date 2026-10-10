-- What a grant ended as, for the upload status query (inner#1367). A grant
-- with no node has no task row to carry its outcome, so the grant does:
-- `asset_id` names the ledger row its bytes registered as (a dedup hit names
-- the row that already stood), `failure_reason` the reason it was voided.
-- Grants settled before this have neither; the query answers them from
-- `consumed_at` / `voided_at` alone.
ALTER TABLE "upload_grants" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD CONSTRAINT "upload_grants_asset_id_studio_assets_id_fk"
  FOREIGN KEY ("asset_id") REFERENCES "studio_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "failure_reason" text;
