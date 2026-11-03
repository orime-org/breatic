CREATE TABLE enterprise_memberships (
  user_id uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  entry_timezone varchar(64) NOT NULL,
  contract_number varchar(128) NOT NULL,
  team_studios integer NOT NULL,
  projects_per_studio integer NOT NULL,
  concurrent_editors integer NOT NULL,
  studio_members integer NOT NULL,
  project_members integer NOT NULL,
  storage_bytes bigint NOT NULL,
  fallback_tier varchar(16) NOT NULL,
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT enterprise_memberships_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT enterprise_memberships_limits_check CHECK (
    team_studios >= 0 AND projects_per_studio >= 0 AND concurrent_editors >= 0
    AND studio_members >= 0 AND project_members >= 0 AND storage_bytes BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT enterprise_memberships_contract_check CHECK (char_length(btrim(contract_number)) BETWEEN 1 AND 128 AND contract_number = btrim(contract_number)),
  CONSTRAINT enterprise_memberships_origin_check CHECK (fallback_tier IN ('base', 'self_hosted')),
  CONSTRAINT enterprise_memberships_revision_check CHECK (revision > 0),
  CONSTRAINT enterprise_memberships_expiry_check CHECK (isfinite(expires_at))
);
--> statement-breakpoint
CREATE TABLE enterprise_membership_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  request_hash varchar(64) NOT NULL,
  target_user_id uuid NOT NULL,
  requested_by varchar(255) NOT NULL,
  request_body jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT enterprise_membership_operations_key_check CHECK (key ~* '^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT enterprise_membership_operations_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT enterprise_membership_operations_result_check CHECK (
    jsonb_typeof(result) = 'object' AND result ? 'status' AND result->>'status' IN ('applied', 'refused')
  ),
  CONSTRAINT enterprise_membership_operations_body_check CHECK (jsonb_typeof(request_body) = 'object')
);
