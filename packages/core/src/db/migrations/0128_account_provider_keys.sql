-- Accounts' own upstream keys (inner#1953), kept with the accounts they belong
-- to.
--
-- account_provider_keys holds the only copy of a saved key, sealed. A live row
-- always has its sealed text; replacing, deleting or erasing a key clears the
-- text and soft-deletes the row in one write, so a task that still names the
-- row by id can no longer read a key from it.
CREATE TABLE account_provider_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  upstream text NOT NULL,
  ciphertext text,
  display_hint text NOT NULL,
  last_checked_at timestamptz,
  last_connected boolean,
  last_balance_amount numeric,
  last_balance_currency varchar(8),
  last_balance_state text,
  last_failure text,
  -- Whether the key can read the actual costs of its calls (fal's billing
  -- events); null where the upstream has no such probe.
  last_costs_readable boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT account_provider_keys_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT account_provider_keys_upstream_check CHECK (char_length(upstream) BETWEEN 1 AND 64),
  CONSTRAINT account_provider_keys_sealed_while_live_check CHECK ((deleted_at IS NULL) = (ciphertext IS NOT NULL)),
  CONSTRAINT account_provider_keys_hint_check CHECK (char_length(display_hint) <= 32),
  CONSTRAINT account_provider_keys_balance_state_check CHECK (
    last_balance_state IS NULL OR last_balance_state IN ('known', 'unsupported', 'forbidden', 'no_cap')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX account_provider_keys_live_key ON account_provider_keys (user_id, upstream) WHERE deleted_at IS NULL;
--> statement-breakpoint

-- The upstream an account chose for a catalog model that is not a language
-- model; a model with no live choice runs on the deployment's keys.
CREATE TABLE account_model_upstreams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  model text NOT NULL,
  upstream text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT account_model_upstreams_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT account_model_upstreams_model_check CHECK (char_length(model) BETWEEN 1 AND 100),
  CONSTRAINT account_model_upstreams_upstream_check CHECK (char_length(upstream) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX account_model_upstreams_live_key ON account_model_upstreams (user_id, model) WHERE deleted_at IS NULL;
--> statement-breakpoint

-- Which account key row a run used; null is the deployment's keys. A key row
-- is retired, never removed, so the reference keeps naming its upstream.
ALTER TABLE tasks ADD COLUMN key_id uuid CONSTRAINT tasks_key_id_fk REFERENCES account_provider_keys (id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN llm_key_id uuid CONSTRAINT tasks_llm_key_id_fk REFERENCES account_provider_keys (id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE timeline_executions ADD COLUMN llm_key_id uuid CONSTRAINT timeline_executions_llm_key_id_fk REFERENCES account_provider_keys (id) ON DELETE RESTRICT;
--> statement-breakpoint
-- The upstream a failure of the payer's own key names, so the page can say
-- whose key failed where; null for any other failure.
ALTER TABLE timeline_executions ADD COLUMN failure_upstream text;
--> statement-breakpoint
-- Why that upstream refused the payer's own key (account_key_failed).
ALTER TABLE timeline_executions ADD COLUMN failure_key_reason text;
--> statement-breakpoint
ALTER TABLE agent_usage_records ADD COLUMN key_id uuid CONSTRAINT agent_usage_records_key_id_fk REFERENCES account_provider_keys (id) ON DELETE RESTRICT;
--> statement-breakpoint

-- A clone lives on the upstream account whose key made it: 'deployment' for
-- ours, the account's id for an account's key. Every row so far was made with
-- ours, which the default fills in. Never null, so the live-uniqueness index
-- covers every owner (NULLs never collide in a unique index).
ALTER TABLE studio_upstream_clones ADD COLUMN key_owner text NOT NULL DEFAULT 'deployment';
--> statement-breakpoint
DROP INDEX "studio_upstream_clones_live_key";
--> statement-breakpoint
CREATE UNIQUE INDEX "studio_upstream_clones_live_key" ON "studio_upstream_clones" ("studio_id", "upstream", "kind", "source_key", "key_owner") WHERE "deleted_at" IS NULL;
