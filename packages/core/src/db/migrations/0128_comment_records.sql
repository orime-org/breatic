-- Comment records (#1488 §11.6, §11.7): which members each comment entry
-- mentions and which threads are handed to an external agent, derived by
-- collab from a Space document's bytes after each store. Rows a store no
-- longer reads are voided (deleted_at), and come back when the content does.
CREATE TABLE comment_mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  space_id uuid NOT NULL,
  entry_id text NOT NULL,
  thread_id text NOT NULL,
  user_id uuid NOT NULL,
  author_id uuid NOT NULL,
  mentioned_at timestamptz NOT NULL,
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT comment_mentions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);
--> statement-breakpoint
-- One row per entry and member, voided or not, so a mention that comes back
-- reuses its row and its notified_at.
CREATE UNIQUE INDEX comment_mentions_entry_user_key ON comment_mentions (project_id, space_id, entry_id, user_id);
--> statement-breakpoint
CREATE TABLE comment_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  space_id uuid NOT NULL,
  thread_id text NOT NULL,
  connection_id uuid NOT NULL,
  assigned_by uuid NOT NULL,
  assigned_at bigint NOT NULL,
  status text NOT NULL,
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT comment_assignments_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT comment_assignments_status_check CHECK (status IN ('pending', 'answered', 'resolved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX comment_assignments_thread_key ON comment_assignments (project_id, space_id, thread_id);
--> statement-breakpoint
-- An agent's pending hand-overs, read on every tool call.
CREATE INDEX comment_assignments_connection_idx ON comment_assignments (connection_id, status) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- What one person handed over in one Space, read for the thread labels.
CREATE INDEX comment_assignments_space_giver_idx ON comment_assignments (project_id, space_id, assigned_by) WHERE deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK (
	"type" IN (
		'access.role_upgrade_request',
		'access.role_upgrade_approved',
		'access.role_upgrade_rejected',
		'studio.transfer_request',
		'studio.transfer_approved',
		'studio.invite_request',
		'studio.invite_accepted',
		'project.invite_request',
		'project.invite_accepted',
		'project.transfer_request',
		'project.transfer_approved',
		'project.join_request',
		'project.join_approved',
		'project.join_rejected',
		'membership.ended',
		'membership.upgrade_incomplete',
		'storage.quota_exceeded',
		'credit.refund_completed',
		'credit.refund_rejected',
		'credit.refund_restored',
		'comment.mentioned',
		'comment.assignment_answered'
	)
);
