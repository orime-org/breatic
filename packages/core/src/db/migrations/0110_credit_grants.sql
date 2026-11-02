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
  legacy_confirmation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_gifts_source_fk FOREIGN KEY (id,source_kind) REFERENCES credit_sources(id,kind) ON DELETE RESTRICT,
  CONSTRAINT credit_gifts_metadata_check CHECK ((
    (origin = 'registration' AND id = target_user_id AND reason IS NULL AND operation_key IS NULL AND requested_by IS NULL AND legacy_confirmation IS NULL)
    OR (origin = 'operator' AND legacy_confirmation IS NULL AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500
      AND operation_key IS NOT NULL AND requested_by IS NOT NULL
      AND credits >= 0.01 AND credits <= 99999999999999.99 AND credits = trunc(credits,2))
    OR (origin = 'operator' AND id <> target_user_id AND reason IS NULL AND operation_key IS NULL AND requested_by IS NULL
      AND jsonb_typeof(legacy_confirmation) = 'object'
      AND legacy_confirmation ?& ARRAY['schemaVersion','kind','sourceId','lotId','targetUserId','personalStudioId','originalCredits','sourceCreatedAt','lotCreatedAt','receiptSha256','confirmedAt']
      AND legacy_confirmation - ARRAY['schemaVersion','kind','sourceId','lotId','targetUserId','personalStudioId','originalCredits','sourceCreatedAt','lotCreatedAt','receiptSha256','confirmedAt'] = '{}'::jsonb
      AND legacy_confirmation->'schemaVersion' = '1'::jsonb
      AND legacy_confirmation->>'kind' = 'user_confirmed_historical_manual_gift'
      AND legacy_confirmation->>'sourceId' = id::text
      AND legacy_confirmation->>'targetUserId' = target_user_id::text
      AND legacy_confirmation->>'personalStudioId' = personal_studio_id::text
      AND jsonb_typeof(legacy_confirmation->'originalCredits') = 'string'
      AND legacy_confirmation->>'originalCredits' = credits::text
      AND jsonb_typeof(legacy_confirmation->'lotId') = 'string'
      AND legacy_confirmation->>'lotId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND jsonb_typeof(legacy_confirmation->'sourceCreatedAt') = 'string'
      AND (legacy_confirmation->>'sourceCreatedAt')::timestamptz = created_at
      AND jsonb_typeof(legacy_confirmation->'lotCreatedAt') = 'string'
      AND isfinite((legacy_confirmation->>'lotCreatedAt')::timestamptz)
      AND jsonb_typeof(legacy_confirmation->'receiptSha256') = 'string'
      AND legacy_confirmation->>'receiptSha256' ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(legacy_confirmation->'confirmedAt') = 'string'
      AND isfinite((legacy_confirmation->>'confirmedAt')::timestamptz))
  ) IS TRUE)
);
--> statement-breakpoint
-- A confirmation is an explicit migration-only adoption of an existing gift.
-- It never opens a source, lot, ledger entry or original operator decision.
DO $$
DECLARE
  confirmation jsonb := (SELECT NULLIF(current_setting('breatic.legacy_gift_confirmation', true),'')::jsonb);
  invalid_count integer;
BEGIN
  IF (SELECT confirmation IS NOT NULL) THEN
    IF (SELECT (jsonb_typeof(confirmation) = 'object'
      AND confirmation ?& ARRAY['schemaVersion','kind','sourceId','lotId','targetUserId','personalStudioId','originalCredits','sourceCreatedAt','lotCreatedAt','receiptSha256','confirmedAt']
      AND confirmation - ARRAY['schemaVersion','kind','sourceId','lotId','targetUserId','personalStudioId','originalCredits','sourceCreatedAt','lotCreatedAt','receiptSha256','confirmedAt'] = '{}'::jsonb
      AND confirmation->'schemaVersion' = '1'::jsonb
      AND confirmation->>'kind' = 'user_confirmed_historical_manual_gift'
      AND jsonb_typeof(confirmation->'originalCredits') = 'string'
      AND jsonb_typeof(confirmation->'receiptSha256') = 'string'
      AND confirmation->>'receiptSha256' ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(confirmation->'confirmedAt') = 'string'
      AND isfinite((confirmation->>'confirmedAt')::timestamptz)
    ) IS NOT TRUE) THEN
      RAISE EXCEPTION 'Invalid historical manual gift confirmation';
    END IF;

    SELECT count(*) INTO invalid_count
    FROM credit_sources s LEFT JOIN credit_lots l ON l.source_id=s.id AND l.source_kind='gift'
    WHERE s.kind='gift' AND (l.id IS NULL OR l.user_id IS DISTINCT FROM s.id
      OR l.designated_studio_id IS NULL OR l.purchased_credits<=0);

    IF (SELECT invalid_count <> 1 OR NOT EXISTS (
      SELECT 1 FROM credit_sources s
      JOIN credit_lots l ON l.source_id=s.id AND l.source_kind='gift'
      JOIN users u ON u.id=l.user_id
      JOIN studios st ON st.id=l.designated_studio_id
      JOIN studio_members m ON m.studio_id=st.id AND m.user_id=l.user_id
      WHERE s.kind='gift' AND s.id<>l.user_id
        AND s.id::text=confirmation->>'sourceId'
        AND l.id::text=confirmation->>'lotId'
        AND l.user_id::text=confirmation->>'targetUserId'
        AND l.designated_studio_id::text=confirmation->>'personalStudioId'
        AND l.purchased_credits>0 AND l.purchased_credits::text=confirmation->>'originalCredits'
        AND s.created_at=(confirmation->>'sourceCreatedAt')::timestamptz
        AND l.created_at=(confirmation->>'lotCreatedAt')::timestamptz
        AND st.type='personal' AND m.role='admin' AND m.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM users other_account WHERE other_account.id=s.id)
        AND l.remaining_credits=(SELECT coalesce(sum(e.amount),0) FROM credit_ledger e WHERE e.lot_id=l.id)
        AND l.purchased_credits=(SELECT coalesce(sum(e.amount),0) FROM credit_ledger e WHERE e.lot_id=l.id AND e.entry_type='topup')
    )) THEN
      RAISE EXCEPTION 'Historical manual gift confirmation does not match existing funding facts';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO credit_gifts(id,source_kind,origin,target_user_id,personal_studio_id,credits,created_at,legacy_confirmation)
SELECT s.id,'gift',CASE WHEN s.id=l.user_id THEN 'registration' ELSE 'operator' END,
  l.user_id,l.designated_studio_id,l.purchased_credits,s.created_at,
  CASE WHEN s.id=l.user_id THEN NULL ELSE NULLIF(current_setting('breatic.legacy_gift_confirmation', true),'')::jsonb END
FROM credit_sources s LEFT JOIN credit_lots l ON l.source_id=s.id AND l.source_kind='gift'
WHERE s.kind='gift';
