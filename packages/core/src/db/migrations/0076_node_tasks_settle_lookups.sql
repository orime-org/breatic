-- The two lookups every settle starts from (#186).
--
-- A report from the ingest Worker names a storage key and nothing else, and a
-- generation names its job and the node it landed on. Both run before the row
-- can be moved, on a table that only ever grows: node_tasks is soft-delete
-- only, so a project's whole history of tasks stays in it.
--
-- Neither is served by the two indexes 0070 created. `node_tasks_node_idx`
-- leads on project_id, which neither query carries; `node_tasks_live_idx` is
-- partial on `deleted_at IS NULL`, a predicate neither query states.

-- Only an upload row carries a storage key, so the index holds just those.
CREATE INDEX IF NOT EXISTS "node_tasks_storage_key_idx"
  ON "node_tasks" ("storage_key")
  WHERE "storage_key" IS NOT NULL;--> statement-breakpoint

-- Same for a job id: it is there on the rows a generation opened.
CREATE INDEX IF NOT EXISTS "node_tasks_job_node_idx"
  ON "node_tasks" ("task_id", "node_id")
  WHERE "task_id" IS NOT NULL;
