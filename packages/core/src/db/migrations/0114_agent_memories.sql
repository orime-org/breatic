-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: Elastic-2.0

-- Product database (#1363): the Agent's memory as one row per fact, and the
-- model each conversation is answered by. A row with no conversation belongs
-- to the member's Project; a row with one belongs to that conversation only.
CREATE TABLE agent_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL CONSTRAINT agent_memories_user_id_fkey REFERENCES users(id) ON DELETE RESTRICT,
  project_id uuid CONSTRAINT agent_memories_project_id_fkey REFERENCES projects(id) ON DELETE RESTRICT,
  conversation_id uuid CONSTRAINT agent_memories_conversation_id_fkey REFERENCES conversations(id) ON DELETE RESTRICT,
  source_conversation_id uuid CONSTRAINT agent_memories_source_conversation_id_fkey REFERENCES conversations(id) ON DELETE RESTRICT,
  title varchar(200) NOT NULL,
  content text NOT NULL,
  origin varchar(20) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT agent_memories_scope_check CHECK (conversation_id IS NOT NULL OR project_id IS NOT NULL),
  CONSTRAINT agent_memories_origin_check CHECK (origin IN ('agent', 'consolidation', 'migration'))
);
--> statement-breakpoint
CREATE INDEX agent_memories_project_idx ON agent_memories(user_id, project_id, updated_at DESC)
  WHERE deleted_at IS NULL AND conversation_id IS NULL;
--> statement-breakpoint
CREATE INDEX agent_memories_conversation_idx ON agent_memories(conversation_id, updated_at DESC)
  WHERE deleted_at IS NULL AND conversation_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN agent_model varchar(100);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN agent_model varchar(100);
