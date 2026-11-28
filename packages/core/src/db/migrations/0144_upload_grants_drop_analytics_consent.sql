-- The collaboration milestone is gone (inner#2051), and it was the only reader
-- of the uploading browser's consent kept on an upload ticket.
ALTER TABLE "upload_grants" DROP COLUMN "analytics_consent";
