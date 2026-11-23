-- The deadline sweep reads the focus crops whose upload is still open when their two hours run out (#1580). Only
-- such grants are indexed: one that is consumed or voided has already ended its crop.
CREATE INDEX "upload_grants_open_focus_idx" ON "upload_grants" ("created_at") WHERE "focus_image" IS NOT NULL AND "consumed_at" IS NULL AND "voided_at" IS NULL;
