-- External-agent access (#1488): the records server's OAuth authorization
-- server stores, the personal access tokens users create, and one connection
-- row per authorized client or token that the user sees and can disconnect.
CREATE TABLE oauth_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model text NOT NULL,
  record_id text NOT NULL,
  payload jsonb NOT NULL,
  grant_id text,
  account_id text,
  client_id text,
  uid text,
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT oauth_records_payload_check CHECK (jsonb_typeof(payload) = 'object')
);
--> statement-breakpoint
-- Live rows only, so a destroyed record does not block storing the same id again.
CREATE UNIQUE INDEX oauth_records_live_key ON oauth_records (model, record_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX oauth_records_grant_idx ON oauth_records (grant_id);
--> statement-breakpoint
CREATE INDEX oauth_records_uid_idx ON oauth_records (model, uid);
--> statement-breakpoint
-- A connection's grants are found by who authorized which client.
CREATE INDEX oauth_records_grant_owner_idx ON oauth_records (account_id, client_id)
  WHERE model = 'Grant' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE personal_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT personal_access_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT personal_access_tokens_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX personal_access_tokens_user_idx ON personal_access_tokens (user_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE agent_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL,
  client_key text NOT NULL,
  display_name text NOT NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT agent_connections_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT agent_connections_kind_check CHECK (kind IN ('cimd', 'dcr', 'pat'))
);
--> statement-breakpoint
-- One live row per user and OAuth client; each personal access token is its own row.
CREATE UNIQUE INDEX agent_connections_live_client_key ON agent_connections (user_id, client_key)
  WHERE deleted_at IS NULL AND kind IN ('cimd', 'dcr');
--> statement-breakpoint
CREATE INDEX agent_connections_user_idx ON agent_connections (user_id) WHERE deleted_at IS NULL;
