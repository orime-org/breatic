-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

-- The Space placeholder an upload's result is written into (inner#1709): a Document body block or a
-- Timeline upload clip, named by its upload id, and which of the two Space types holds it. Every placeholder named
-- before this migration is a Document block.
ALTER TABLE upload_grants RENAME COLUMN document_upload_id TO space_upload_id;--> statement-breakpoint
ALTER TABLE upload_grants ADD COLUMN space_upload_target text;--> statement-breakpoint
UPDATE upload_grants SET space_upload_target = 'document' WHERE space_upload_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE upload_grants ADD CONSTRAINT upload_grants_space_upload_target_check
  CHECK (space_upload_target IS NULL OR space_upload_target IN ('document', 'timeline'));--> statement-breakpoint
ALTER TABLE upload_grants ADD CONSTRAINT upload_grants_space_upload_paired
  CHECK ((space_upload_id IS NULL) = (space_upload_target IS NULL));
