-- The deadline sweep reads the notifications that come due in its window, across every user (#1580). Only rows that
-- can come due are indexed: a notification with no expiry never does, and a removed one is never shown.
CREATE INDEX "notifications_expires_at_idx" ON "notifications" ("expires_at") WHERE "expires_at" IS NOT NULL AND "deleted_at" IS NULL;
