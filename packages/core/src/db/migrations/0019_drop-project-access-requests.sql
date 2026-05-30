-- Drop the dead `project_access_requests` table.
--
-- The self-service "request to join a project" flow was cut on the
-- 2026-05-28 access-permission redesign in favour of owner-invite-only
-- semantics ("link = direct access"). The accepted spec § 2.2 forbids
-- "凭 projectId 构造申请" (anyone with a projectId spamming the owner
-- with requests) — which is exactly what this table backed. The whole
-- subsystem (routes / service / repo / mail builders / frontend api)
-- was removed; this migration drops its only schema artifact.
--
-- DROP ... CASCADE also removes the table's indexes
-- (par_project_status_idx, par_requester_idx, the partial-unique
-- pending-request index) and FK constraints. Nothing references this
-- table (it is a leaf — it references projects/users, not vice versa),
-- so the CASCADE only cleans up its own dependent objects.
--
-- spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 2.2

DROP TABLE IF EXISTS "project_access_requests" CASCADE;
