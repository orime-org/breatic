-- Create the separate Yjs-document-store database alongside the business
-- database. Runs once, on first init of the postgres data volume (the
-- postgres:16-alpine image executes /docker-entrypoint-initdb.d/*.sql then).
-- For an existing volume, create it manually:
--   docker compose exec postgres psql -U breatic -c "CREATE DATABASE breatic_yjs;"
CREATE DATABASE breatic_yjs;
