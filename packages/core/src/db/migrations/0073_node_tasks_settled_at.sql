-- The moment a task reached one of its three end states (#186).
--
-- The list a user opens shows a finished task's own time, and `updated_at`
-- cannot answer that: it moves again whenever anything else touches the row,
-- including the report that lands after a task was judged dead and fills in
-- `node_history_id`. So the end state gets a column that is written once.
--
-- Null while a task is running, and on the rows that were opened before this
-- column existed.
ALTER TABLE "node_tasks" ADD COLUMN "settled_at" timestamp with time zone;
