-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
  CONSTRAINT credit_grant_operations_result_check CHECK (jsonb_typeof(result) = 'object' AND result->>'status' IN ('applied','refused'))
);
--> statement-breakpoint
CREATE TABLE credit_compensations (
  id uuid PRIMARY KEY,
  source_kind varchar(16) NOT NULL DEFAULT 'compensation' CHECK (source_kind = 'compensation'),
  target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  personal_studio_id uuid NOT NULL REFERENCES studios(id) ON DELETE RESTRICT,
  credits numeric(20,6) NOT NULL CHECK (credits >= 0.01 AND credits <= 99999999999999.99 AND credits = trunc(credits,2)),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  operation_key text NOT NULL UNIQUE REFERENCES credit_grant_operations(key) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_compensations_source_fk FOREIGN KEY (id,source_kind) REFERENCES credit_sources(id,kind) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE credit_gifts (
  id uuid PRIMARY KEY,
  source_kind varchar(16) NOT NULL DEFAULT 'gift' CHECK (source_kind = 'gift'),
  origin varchar(16) NOT NULL CHECK (origin IN ('registration','operator')),
  target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  personal_studio_id uuid NOT NULL REFERENCES studios(id) ON DELETE RESTRICT,
  credits numeric(20,6) NOT NULL CHECK (credits > 0),
  reason text,
  operation_key text UNIQUE REFERENCES credit_grant_operations(key) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
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
-- Include depleted and soft-deleted lots: these are historical receipts.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM credit_sources s LEFT JOIN credit_lots l ON l.source_id=s.id
    WHERE s.kind='gift' AND (l.id IS NULL OR l.source_kind <> 'gift' OR s.id <> l.user_id OR l.designated_studio_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Historical gift source cannot be classified as a registration claim';
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO credit_gifts(id,source_kind,origin,target_user_id,personal_studio_id,credits,created_at)
SELECT s.id,'gift','registration',l.user_id,l.designated_studio_id,l.purchased_credits,s.created_at
FROM credit_sources s JOIN credit_lots l ON l.source_id=s.id WHERE s.kind='gift';
