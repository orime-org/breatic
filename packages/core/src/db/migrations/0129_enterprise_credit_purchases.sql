-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

ALTER TABLE credit_sources DROP CONSTRAINT credit_sources_kind_check;
--> statement-breakpoint
ALTER TABLE credit_sources ADD CONSTRAINT credit_sources_kind_check CHECK (kind IN ('payment','compensation','gift','discount','enterprise'));
--> statement-breakpoint
CREATE TABLE enterprise_credit_purchase_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  request_hash varchar(64) NOT NULL,
  target_user_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  request_body jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_credit_purchase_operations_key_check CHECK (key ~* '^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT enterprise_credit_purchase_operations_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT enterprise_credit_purchase_operations_body_check CHECK (jsonb_typeof(request_body) = 'object'),
  CONSTRAINT enterprise_credit_purchase_operations_result_check CHECK (jsonb_typeof(result) = 'object' AND result->>'status' IS NOT NULL AND result->>'status' IN ('applied','refused'))
);
--> statement-breakpoint
CREATE TABLE credit_enterprise_purchases (
  id uuid PRIMARY KEY,
  source_kind varchar(16) NOT NULL DEFAULT 'enterprise' CHECK (source_kind = 'enterprise'),
  target_user_id uuid NOT NULL CONSTRAINT credit_enterprise_purchases_user_fk REFERENCES users(id) ON DELETE RESTRICT,
  credits numeric(20,6) NOT NULL CHECK (credits >= 0.01 AND credits <= 99999999999999.99 AND credits = trunc(credits,2)),
  contract_number text NOT NULL CHECK (length(btrim(contract_number)) BETWEEN 1 AND 128),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  operation_key text NOT NULL UNIQUE CONSTRAINT credit_enterprise_purchases_operation_fk REFERENCES enterprise_credit_purchase_operations(key) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_enterprise_purchases_source_fk FOREIGN KEY (id,source_kind) REFERENCES credit_sources(id,kind) ON DELETE RESTRICT
);
