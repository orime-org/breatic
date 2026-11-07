-- Referral program, first slice (inner#1868): promoter applications reviewed in
-- the back office, one referral code per approved promoter, a permanent binding
-- per referred account, and the idempotent record of every back-office write.
CREATE TABLE promoter_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL,
  country char(2) NOT NULL,
  channels jsonb NOT NULL,
  plan text NOT NULL,
  terms_version varchar(32) NOT NULL,
  terms_accepted_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by varchar(64),
  decision_reason text,
  applicant_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT promoter_applications_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT promoter_applications_country_check CHECK (country ~ '^[A-Z]{2}$'),
  CONSTRAINT promoter_applications_channels_check CHECK (
    jsonb_typeof(channels) = 'array' AND jsonb_array_length(channels) BETWEEN 1 AND 10
  ),
  CONSTRAINT promoter_applications_plan_check CHECK (char_length(plan) BETWEEN 1 AND 2000),
  CONSTRAINT promoter_applications_terms_check CHECK (char_length(terms_version) >= 1),
  CONSTRAINT promoter_applications_decision_check CHECK (
    (status = 'pending') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL)
  ),
  CONSTRAINT promoter_applications_reason_check CHECK (decision_reason IS NULL OR char_length(decision_reason) <= 500),
  CONSTRAINT promoter_applications_note_check CHECK (applicant_note IS NULL OR char_length(applicant_note) <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX promoter_applications_one_pending ON promoter_applications (user_id)
  WHERE status = 'pending' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX promoter_applications_one_approved ON promoter_applications (user_id)
  WHERE status = 'approved' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX promoter_applications_page ON promoter_applications (created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL UNIQUE,
  promoter_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  application_id uuid NOT NULL UNIQUE REFERENCES promoter_applications(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active',
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_codes_code_check CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,18}[A-Z0-9]$'),
  CONSTRAINT referral_codes_status_check CHECK (status IN ('active', 'disabled', 'removed')),
  CONSTRAINT referral_codes_removed_check CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX referral_codes_page ON referral_codes (created_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE referral_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  referral_code_id uuid NOT NULL REFERENCES referral_codes(id) ON DELETE RESTRICT,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_bindings_source_check CHECK (source IN ('signup_link', 'signup_typed', 'later'))
);
--> statement-breakpoint
CREATE INDEX referral_bindings_code ON referral_bindings (referral_code_id);
--> statement-breakpoint
CREATE TABLE referral_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  kind text NOT NULL,
  target_id uuid NOT NULL,
  request_hash varchar(64) NOT NULL,
  requested_by varchar(64) NOT NULL,
  request_body jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_operations_key_check CHECK (key ~* '^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT referral_operations_kind_check CHECK (kind IN ('approve', 'reject', 'disable', 'enable', 'remove')),
  CONSTRAINT referral_operations_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT referral_operations_body_check CHECK (jsonb_typeof(request_body) = 'object'),
  CONSTRAINT referral_operations_result_check CHECK (
    jsonb_typeof(result) = 'object' AND result->>'status' IN ('applied', 'refused')
  )
);
