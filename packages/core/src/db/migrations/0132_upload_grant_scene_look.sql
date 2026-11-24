-- A picture uploaded for a 3D object's part (inner#1693 design 6.3).
--
-- The browser only sends the bytes; once they are stored, the server tells
-- collab which object and part the upload started from and the picture that
-- part held then, and collab writes the new picture there when it still may.
-- The grant is where the server keeps those three until the report arrives.
-- All three are null on every other upload.
ALTER TABLE "upload_grants" ADD COLUMN "scene_object_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "scene_part" text;--> statement-breakpoint
ALTER TABLE "upload_grants" ADD COLUMN "scene_start_map" text;
