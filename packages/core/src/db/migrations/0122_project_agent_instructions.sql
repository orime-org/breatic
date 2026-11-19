-- Project instructions for the Agent (#1400): one plain text per Project,
-- written by its Owner and Editors and sent at the end of the Agent's system
-- prompt on every request in that Project. Clearing sets deleted_at; a later
-- save brings the same row back.
CREATE TABLE project_agent_instructions (
  project_id uuid PRIMARY KEY,
  content text NOT NULL,
  updated_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT project_agent_instructions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT project_agent_instructions_updated_by_fk FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
);
