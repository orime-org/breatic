-- Rewrite stored notifications to carry ids instead of names.
--
-- Notifications used to embed the slug and @handle of whatever they pointed
-- at. Both change: renaming a studio releases its old slug for anyone to
-- claim, and a personal studio's slug IS its owner's @handle — so a stored
-- copy can end up naming a stranger, with nothing in the string to show it
-- went stale. The code now stores ids and resolves display identity at read
-- time; these rows have to follow, or the ones written before this deploy
-- would render with no actor and no link.
--
-- Two distinct shapes, matching the two the code change had to handle:
--
--   1. types that ALREADY carried the id beside the name — just drop the
--      name-shaped keys.
--   2. the four "accepted / approved" types, which carried NO id at all.
--      Their ids are recovered by looking the stored slug back up. That
--      lookup is the reason this cannot be a pure key-drop.
--
-- Lookup rule: resolve against LIVE rows only, and leave the key absent when
-- nothing matches. The slug uniqueness index is partial (it only constrains
-- rows that are not soft-deleted), so matching against all rows could hit
-- several and pick the wrong one. An absent id renders as plain text — the
-- reference stops being clickable, which is strictly better than pointing at
-- the wrong studio or the wrong person.
--
-- Idempotent: every statement is scoped by `payload ? '<old key>'`, so a row
-- already rewritten has nothing left to match and a re-run is a no-op.
--
-- Hand-written (same pattern as 0040-0045: .sql + _journal entry, no
-- snapshot).

-- 1. Recover ids for the four types that stored only names ------------------

-- studio.transfer_approved: studioSlug → studioId, accepterHandle → accepterUserId
UPDATE "notifications" n
SET "payload" = n."payload"
  || jsonb_build_object('studioId', s."id")
FROM "studios" s
WHERE n."type" = 'studio.transfer_approved'
  AND n."payload" ? 'studioSlug'
  AND s."slug" = n."payload" ->> 'studioSlug'
  AND s."deleted_at" IS NULL;--> statement-breakpoint

UPDATE "notifications" n
SET "payload" = n."payload"
  || jsonb_build_object('accepterUserId', s."created_by_user_id")
FROM "studios" s
WHERE n."type" = 'studio.transfer_approved'
  AND n."payload" ? 'accepterHandle'
  AND s."slug" = n."payload" ->> 'accepterHandle'
  AND s."type" = 'personal'
  AND s."deleted_at" IS NULL;--> statement-breakpoint

-- studio.invite_accepted: studioSlug → studioId, inviteeHandle → inviteeUserId
UPDATE "notifications" n
SET "payload" = n."payload"
  || jsonb_build_object('studioId', s."id")
FROM "studios" s
WHERE n."type" = 'studio.invite_accepted'
  AND n."payload" ? 'studioSlug'
  AND s."slug" = n."payload" ->> 'studioSlug'
  AND s."deleted_at" IS NULL;--> statement-breakpoint

UPDATE "notifications" n
SET "payload" = n."payload"
  || jsonb_build_object('inviteeUserId', s."created_by_user_id")
FROM "studios" s
WHERE n."type" = 'studio.invite_accepted'
  AND n."payload" ? 'inviteeHandle'
  AND s."slug" = n."payload" ->> 'inviteeHandle'
  AND s."type" = 'personal'
  AND s."deleted_at" IS NULL;--> statement-breakpoint

-- project.transfer_approved / project.invite_accepted: the project id is
-- already on the ROW (notifications.project_id), so it only needs copying in.
UPDATE "notifications"
SET "payload" = "payload" || jsonb_build_object('projectId', "project_id")
WHERE "type" IN ('project.transfer_approved', 'project.invite_accepted')
  AND "project_id" IS NOT NULL
  AND NOT ("payload" ? 'projectId');--> statement-breakpoint

UPDATE "notifications" n
SET "payload" = n."payload"
  || jsonb_build_object('accepterUserId', s."created_by_user_id")
FROM "studios" s
WHERE n."type" = 'project.transfer_approved'
  AND n."payload" ? 'accepterHandle'
  AND s."slug" = n."payload" ->> 'accepterHandle'
  AND s."type" = 'personal'
  AND s."deleted_at" IS NULL;--> statement-breakpoint

UPDATE "notifications" n
SET "payload" = n."payload"
  || jsonb_build_object('inviteeUserId', s."created_by_user_id")
FROM "studios" s
WHERE n."type" = 'project.invite_accepted'
  AND n."payload" ? 'inviteeHandle'
  AND s."slug" = n."payload" ->> 'inviteeHandle'
  AND s."type" = 'personal'
  AND s."deleted_at" IS NULL;--> statement-breakpoint

-- 2. Recover the ids missing from the request-side types --------------------

-- role-upgrade request / decision never carried projectId in the payload,
-- though the row has it.
UPDATE "notifications"
SET "payload" = "payload" || jsonb_build_object('projectId', "project_id")
WHERE "type" IN (
    'access.role_upgrade_request',
    'access.role_upgrade_approved',
    'access.role_upgrade_rejected'
  )
  AND "project_id" IS NOT NULL
  AND NOT ("payload" ? 'projectId');--> statement-breakpoint

UPDATE "notifications" n
SET "payload" = n."payload"
  || jsonb_build_object('deciderUserId', s."created_by_user_id")
FROM "studios" s
WHERE n."type" IN ('access.role_upgrade_approved', 'access.role_upgrade_rejected')
  AND n."payload" ? 'deciderHandle'
  AND s."slug" = n."payload" ->> 'deciderHandle'
  AND s."type" = 'personal'
  AND s."deleted_at" IS NULL;--> statement-breakpoint

-- invite requests carried the inviter's handle but not their id.
UPDATE "notifications" n
SET "payload" = n."payload"
  || jsonb_build_object('inviterUserId', s."created_by_user_id")
FROM "studios" s
WHERE n."type" IN ('studio.invite_request', 'project.invite_request')
  AND n."payload" ? 'inviterHandle'
  AND s."slug" = n."payload" ->> 'inviterHandle'
  AND s."type" = 'personal'
  AND s."deleted_at" IS NULL;--> statement-breakpoint

-- 3. Drop every name-shaped key --------------------------------------------
--
-- Runs last so the lookups above still had their inputs. `-` on a jsonb
-- object removes the key if present and is a no-op otherwise, so this is
-- safe on rows written after the code change.
UPDATE "notifications"
SET "payload" = "payload"
  - 'requesterHandle' - 'deciderHandle' - 'inviterHandle' - 'inviteeHandle'
  - 'fromHandle' - 'accepterHandle' - 'projectSlug' - 'studioSlug'
WHERE "payload" ?| ARRAY[
    'requesterHandle', 'deciderHandle', 'inviterHandle', 'inviteeHandle',
    'fromHandle', 'accepterHandle', 'projectSlug', 'studioSlug'
  ];
