-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

-- Only absolute ISO UTC values are admitted to the immutable expression.
-- Fixed parsing settings exclude session timezone, DateStyle and relative dates.
CREATE FUNCTION mini_tool_settlement_due_at(payload jsonb)
RETURNS timestamp with time zone
LANGUAGE plpgsql
IMMUTABLE STRICT PARALLEL SAFE
SET TimeZone = 'UTC'
SET DateStyle = 'ISO,YMD'
AS $function$
DECLARE
  instant text;
BEGIN
  instant := CASE payload->'settlement'->>'state'
    WHEN 'waiting' THEN payload->'settlement'->>'nextAttemptAt'
    WHEN 'checking' THEN payload->'settlement'->>'leaseUntil'
  END;
  IF instant IS NULL OR instant !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?Z$' THEN
    RETURN NULL;
  END IF;
  RETURN instant::timestamp with time zone;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN NULL;
END;
$function$;

--> statement-breakpoint
CREATE INDEX tasks_mini_tool_settlement_due_idx
  ON tasks (mini_tool_settlement_due_at(result), id)
  WHERE source = 'mini_tool' AND billed_at IS NULL
    AND jsonb_typeof(result->'settlement'->'version') = 'number'
    AND result->'settlement'->>'state' IN ('waiting', 'checking');
