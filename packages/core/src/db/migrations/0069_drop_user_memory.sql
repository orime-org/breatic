-- Task #148 — the user memory layer retires, tables and all.
--
-- Memory is two layers now, conversation and project, and both are read and
-- written through `memory.repo.ts`. Nothing has touched these two tables since
-- the reads and writes came out: `grep userMemories packages/*/src` returns
-- the schema declaration and nothing else.
--
-- Left declared they are worse than absent — a fully typed, exported table
-- with a unique index on `user_id`, which is what the next person adding a
-- memory read would find. The rows they hold were written during development.
--
-- Neither points at the other, so the order is free; entries first reads the
-- way the pair was created.

DROP TABLE IF EXISTS "user_memory_entries";--> statement-breakpoint
DROP TABLE IF EXISTS "user_memories";
