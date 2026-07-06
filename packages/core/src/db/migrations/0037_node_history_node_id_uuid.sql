-- node_history.node_id type accuracy (#1620). Canvas node ids are v4 UUIDs
-- (@breatic/shared newId() = uuidv4()), and the sibling project_activities
-- table already types node_id as uuid. node_history's node_id was left
-- varchar(255) from the pre-uuid-migration era ("1002-<ts>-<rand>" ids).
-- Tighten it to uuid to match the actual data + the sibling table. Pre-launch:
-- no rows, so the USING cast is a formality (dependent indexes —
-- node_history_node_idx + the 0036 partial unique on (task_id, node_id) — are
-- rebuilt by the ALTER). Hand-written (same pattern as 0025..0036: .sql +
-- _journal entry, no snapshot).
ALTER TABLE "node_history"
  ALTER COLUMN "node_id" TYPE uuid USING "node_id"::uuid;
