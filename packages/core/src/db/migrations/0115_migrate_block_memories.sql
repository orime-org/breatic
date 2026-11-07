-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: Elastic-2.0

-- Product database (#1363): every block of memory written before entries
-- existed becomes one entry, word for word; the next consolidation splits it.
-- A conversation block's row is emptied afterwards, because from then on that
-- row holds the progress note. Running it again adds nothing: a project block
-- is skipped when its member already has a migrated entry in that Project, and
-- a conversation block is empty once moved.
INSERT INTO agent_memories (user_id, project_id, conversation_id, source_conversation_id, title, content, origin)
SELECT pm.user_id, pm.project_id, NULL, NULL, 'Earlier project memory', pm.content, 'migration'
FROM project_memories pm
WHERE pm.deleted_at IS NULL
  AND pm.content <> ''
  AND NOT EXISTS (
    SELECT 1 FROM agent_memories am
    WHERE am.user_id = pm.user_id
      AND am.project_id = pm.project_id
      AND am.conversation_id IS NULL
      AND am.origin = 'migration'
  );
--> statement-breakpoint
INSERT INTO agent_memories (user_id, project_id, conversation_id, source_conversation_id, title, content, origin)
SELECT c.user_id, c.project_id, c.id, c.id, 'Earlier conversation memory', cm.content, 'migration'
FROM conversation_memories cm
JOIN conversations c ON c.id = cm.conversation_id
WHERE cm.deleted_at IS NULL
  AND cm.content <> ''
  AND c.deleted_at IS NULL;
--> statement-breakpoint
UPDATE conversation_memories cm
SET content = '', updated_at = now()
FROM conversations c
WHERE c.id = cm.conversation_id
  AND cm.deleted_at IS NULL
  AND cm.content <> ''
  AND c.deleted_at IS NULL;
