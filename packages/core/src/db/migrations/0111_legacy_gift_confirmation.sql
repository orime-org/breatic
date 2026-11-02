-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: AGPL-3.0-only

-- The corrected initial migration already installs this exact schema. Avoid
-- ALTER TABLE after its deferred FK events in the same migration transaction.
DO $$
BEGIN
  IF (SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='credit_gifts' AND column_name='legacy_confirmation')) THEN
    ALTER TABLE credit_gifts ADD COLUMN legacy_confirmation jsonb;
    ALTER TABLE credit_gifts DROP CONSTRAINT credit_gifts_metadata_check;
    ALTER TABLE credit_gifts ADD CONSTRAINT credit_gifts_metadata_check CHECK ((
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
      ) IS TRUE);
  END IF;
END $$;
