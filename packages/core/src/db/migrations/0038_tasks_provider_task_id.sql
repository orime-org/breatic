-- tasks.provider_task_id for async-generation resume (#1628, #1625 ⑦).
-- Async vendors (video / async image / async audio / 3D) submit a job and
-- return a task id, then we poll. On a BullMQ whole-job retry, re-submitting
-- would create a duplicate (billed) vendor task. Persist the vendor task id
-- right after submit so a retry resumes by polling this id instead of
-- re-submitting. Nullable (sync providers never set it). Hand-written (same
-- pattern as 0025..0037: .sql + _journal entry, no snapshot).
ALTER TABLE "tasks"
  ADD COLUMN "provider_task_id" text;
