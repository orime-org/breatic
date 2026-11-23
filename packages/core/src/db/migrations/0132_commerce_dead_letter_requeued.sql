-- Copyright (c) 2026 Orime, Inc.
-- SPDX-License-Identifier: AGPL-3.0-only

-- When a dead letter was last put back into the outbox (inner#1993 §5.2), so a rerun by reason skips it.
ALTER TABLE commerce_outbox_dead_letters ADD COLUMN requeued_at timestamptz;
