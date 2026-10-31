-- Final refund API refusals belong to the primary product database.
CREATE TABLE credit_refund_refusals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key varchar(255) NOT NULL UNIQUE,
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  request_kind varchar(20) NOT NULL CHECK (request_kind IN ('approve', 'retry', 'reject', 'settle', 'send_back', 'resolve_outside', 'restore_credits', 'resend_mail')),
  target_kind varchar(20) NOT NULL CHECK (target_kind IN ('lot', 'operation')),
  target_id uuid NOT NULL,
  requested_by varchar(64) NOT NULL,
  request_reason text NOT NULL,
  response_status smallint NOT NULL CHECK (response_status IN (404, 409)),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT credit_refund_refusals_target CHECK (
    (request_kind = 'resend_mail' AND target_kind = 'operation') OR
    (request_kind <> 'resend_mail' AND target_kind = 'lot')
  ),
  CONSTRAINT credit_refund_refusals_response CHECK (
    jsonb_typeof(response_body) = 'object' AND
    COALESCE(jsonb_typeof(response_body -> 'code') = 'string', false) AND
    (NOT (response_body ? 'detail') OR jsonb_typeof(response_body -> 'detail') = 'string') AND
    COALESCE((
      (response_status = 404 AND response_body ->> 'code' = 'not_found') OR
      (response_status = 409 AND response_body ->> 'code' IN ('lot_state_changed', 'stripe_blocks', 'operation_in_progress', 'mail_not_resendable'))
    ), false) AND
    CASE WHEN response_body ->> 'code' = 'stripe_blocks' THEN
      COALESCE(response_body ->> 'reason' IN ('refund_in_progress', 'refund_succeeded', 'refund_failed', 'stripe_declined', 'succeeded_sum_changed', 'succeeded_below_paid', 'failed_refunds_changed', 'already_refunded', 'unconfirmed_external_refund', 'paid_outside', 'disputed'), false)
    ELSE NOT (response_body ? 'reason') END
  )
);
