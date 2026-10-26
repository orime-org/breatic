-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: LicenseRef-BSAL-1.0

ALTER TABLE project_invitations ALTER COLUMN invited_user_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE project_invitations ADD COLUMN invited_email varchar(320);
--> statement-breakpoint
ALTER TABLE project_invitations ADD COLUMN claimed_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE project_invitations ADD CONSTRAINT project_invitations_invitee_one_of
  CHECK ((invited_user_id IS NULL) <> (invited_email IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX project_invitations_one_pending_email
  ON project_invitations (project_id, invited_email)
  WHERE status = 'pending' AND deleted_at IS NULL AND invited_user_id IS NULL;
--> statement-breakpoint
CREATE INDEX project_invitations_invited_email_idx
  ON project_invitations (invited_email)
  WHERE status = 'pending' AND invited_user_id IS NULL;
--> statement-breakpoint

ALTER TABLE studio_invitations ALTER COLUMN invited_user_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE studio_invitations ADD COLUMN invited_email varchar(320);
--> statement-breakpoint
ALTER TABLE studio_invitations ADD COLUMN claimed_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE studio_invitations ADD CONSTRAINT studio_invitations_invitee_one_of
  CHECK ((invited_user_id IS NULL) <> (invited_email IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX studio_invitations_one_pending_email
  ON studio_invitations (studio_id, invited_email)
  WHERE status = 'pending' AND deleted_at IS NULL AND invited_user_id IS NULL;
--> statement-breakpoint
CREATE INDEX studio_invitations_invited_email_idx
  ON studio_invitations (invited_email)
  WHERE status = 'pending' AND invited_user_id IS NULL;
