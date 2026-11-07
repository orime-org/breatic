-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: Elastic-2.0

-- Funding receipts and original decisions never expire or soft-delete (inner#1411).
CREATE TABLE credit_grant_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  request_hash varchar(64) NOT NULL,
  target_user_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  request_body jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_grant_operations_key_check CHECK (key ~* '^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT credit_grant_operations_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT credit_grant_operations_body_check CHECK (jsonb_typeof(request_body) = 'object'),
  CONSTRAINT credit_grant_operations_result_check CHECK (jsonb_typeof(result) = 'object' AND result->>'status' IS NOT NULL AND result->>'status' IN ('applied','refused'))
);
--> statement-breakpoint
CREATE TABLE credit_compensations (
  id uuid PRIMARY KEY,
  source_kind varchar(16) NOT NULL DEFAULT 'compensation' CHECK (source_kind = 'compensation'),
  target_user_id uuid NOT NULL CONSTRAINT credit_compensations_user_fk REFERENCES users(id) ON DELETE RESTRICT,
  personal_studio_id uuid NOT NULL CONSTRAINT credit_compensations_studio_fk REFERENCES studios(id) ON DELETE RESTRICT,
  credits numeric(20,6) NOT NULL CHECK (credits >= 0.01 AND credits <= 99999999999999.99 AND credits = trunc(credits,2)),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  operation_key text NOT NULL UNIQUE CONSTRAINT credit_compensations_operation_fk REFERENCES credit_grant_operations(key) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_compensations_source_fk FOREIGN KEY (id,source_kind) REFERENCES credit_sources(id,kind) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE credit_gifts (
  id uuid PRIMARY KEY,
  source_kind varchar(16) NOT NULL DEFAULT 'gift' CHECK (source_kind = 'gift'),
  origin varchar(16) NOT NULL CHECK (origin IN ('registration','operator')),
  target_user_id uuid NOT NULL CONSTRAINT credit_gifts_user_fk REFERENCES users(id) ON DELETE RESTRICT,
  personal_studio_id uuid NOT NULL CONSTRAINT credit_gifts_studio_fk REFERENCES studios(id) ON DELETE RESTRICT,
  credits numeric(20,6) NOT NULL CHECK (credits > 0),
  reason text,
  operation_key text UNIQUE CONSTRAINT credit_gifts_operation_fk REFERENCES credit_grant_operations(key) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_gifts_source_fk FOREIGN KEY (id,source_kind) REFERENCES credit_sources(id,kind) ON DELETE RESTRICT,
  CONSTRAINT credit_gifts_metadata_check CHECK (
    (origin = 'registration' AND id = target_user_id AND reason IS NULL AND operation_key IS NULL AND requested_by IS NULL)
    OR (origin = 'operator' AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500
      AND operation_key IS NOT NULL AND requested_by IS NOT NULL
      AND credits >= 0.01 AND credits <= 99999999999999.99 AND credits = trunc(credits,2))
  )
);
--> statement-breakpoint
-- Include every historical gift source, even depleted or soft-deleted lots.
-- LEFT JOIN is deliberate: a missing lot, wrong lot kind, missing designation,
-- or a source id other than its account fails the receipt constraints rather
-- than silently disappearing from the backfill. All migration writes roll back.
INSERT INTO credit_gifts(id,source_kind,origin,target_user_id,personal_studio_id,credits,created_at)
SELECT s.id,'gift','registration',l.user_id,l.designated_studio_id,l.purchased_credits,s.created_at
FROM credit_sources s LEFT JOIN credit_lots l ON l.source_id=s.id AND l.source_kind='gift'
WHERE s.kind='gift';
