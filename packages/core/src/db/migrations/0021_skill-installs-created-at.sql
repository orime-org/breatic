-- #852 2a (CI maximal-strictness guard suite): rename the skill_installs
-- timestamp column installed_at -> created_at so it complies with the
-- created_at mandate (every PG table must carry a created_at column).
-- The column is semantically the row's creation time; only the name
-- changes. No JS code referenced installedAt outside the schema
-- definition, so this is a pure column rename with no data movement.

ALTER TABLE "skill_installs" RENAME COLUMN "installed_at" TO "created_at";
