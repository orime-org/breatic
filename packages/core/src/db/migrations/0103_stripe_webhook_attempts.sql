CREATE TABLE stripe_webhook_attempts (
  id uuid PRIMARY KEY,
  event_id varchar(255) NOT NULL,
  event_type varchar(80) NOT NULL,
  livemode boolean NOT NULL,
  account_id varchar(255),
  endpoint_id varchar(255),
  connected_account_id varchar(255),
  environment text NOT NULL,
  received_at timestamptz NOT NULL,
  finished_at timestamptz,
  response_status smallint,
  result varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT stripe_webhook_attempts_completion CHECK (
    (finished_at IS NULL AND response_status IS NULL AND result IS NULL)
    OR (
      finished_at IS NOT NULL AND response_status IS NOT NULL AND result IS NOT NULL
      AND response_status BETWEEN 100 AND 599
      AND result IN (
        'credits_granted', 'credits_replay', 'credits_noop', 'credits_expired',
        'credits_payment_failed', 'credits_mismatch', 'credits_unknown',
        'membership_applied', 'membership_replay', 'membership_acknowledged',
        'membership_no_account', 'membership_unknown_price', 'membership_no_subscription',
        'membership_price_disagreement', 'refund_synced', 'refund_no_target',
        'refund_unreadable', 'ignored', 'handler_exception'
      )
    )
  )
);
--> statement-breakpoint
CREATE INDEX stripe_webhook_attempts_received_idx
  ON stripe_webhook_attempts (received_at DESC, id DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX stripe_webhook_attempts_event_idx
  ON stripe_webhook_attempts (event_id, received_at DESC, id DESC)
  WHERE deleted_at IS NULL;
