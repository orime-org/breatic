-- What the product keeps when payments are taken by the billing service
-- (inner#1993 §4.2, §4.6). Only adds; the billing tables stay until 0129.
--
-- payment_receipts: the product's own record of a completed payment, written
-- when the billing service grants it, shaped like credit_gifts and
-- credit_compensations so a lot's source can be read without the billing
-- tables. Backfilled here for every payment already completed.
CREATE TABLE payment_receipts (
  id uuid PRIMARY KEY,
  source_kind varchar(16) NOT NULL DEFAULT 'payment' CHECK (source_kind = 'payment'),
  user_id uuid NOT NULL CONSTRAINT payment_receipts_user_fk REFERENCES users(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  tax_cents integer CHECK (tax_cents >= 0),
  total_cents integer CHECK (total_cents >= 0),
  currency varchar(10) NOT NULL,
  credits_granted numeric(20,6) NOT NULL CHECK (credits_granted >= 0),
  ordered_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_receipts_source_fk FOREIGN KEY (id,source_kind) REFERENCES credit_sources(id,kind) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX payment_receipts_user_ordered_idx ON payment_receipts (user_id, ordered_at, id);
--> statement-breakpoint
INSERT INTO payment_receipts (id, source_kind, user_id, amount_cents, tax_cents, total_cents, currency, credits_granted, ordered_at)
SELECT id, 'payment', user_id, amount_cents, tax_cents, total_cents, currency, round(credits_granted::numeric, 6), created_at
FROM payments
WHERE status = 'completed'
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
-- One row per write the billing service asked of the product, claimed in the
-- same transaction as the write and holding its answer, so a repeat of the
-- same key replays that answer (inner#1993 §3.3).
CREATE TABLE commerce_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  kind text NOT NULL,
  request_hash varchar(64) NOT NULL,
  status text NOT NULL CONSTRAINT commerce_requests_status_check CHECK (status IN ('applied', 'refused')),
  answer jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Events for the billing service, appended in the business transaction and
-- sent by the relay (inner#1993 §5.1). `id` is the delivery id the receiver
-- keys on; `seq` orders the rows of one aggregate.
CREATE TABLE commerce_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  aggregate_key text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
--> statement-breakpoint
CREATE INDEX commerce_outbox_unsent_idx ON commerce_outbox (aggregate_key, seq) WHERE sent_at IS NULL;
--> statement-breakpoint
CREATE TABLE commerce_outbox_dead_letters (
  id uuid PRIMARY KEY,
  seq bigint NOT NULL UNIQUE,
  aggregate_key text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL,
  last_error text,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);
