-- The permission to finish one upload (#186, design §6.4). The ingest Worker
-- takes it before it asks R2 to assemble the object, and the multipart upload
-- id it took it under is what separates a retry of the same delivery from a
-- replay opening a second upload over a key the ledger already describes.
ALTER TABLE "upload_grants" ADD COLUMN "finalizing_upload_id" text;
