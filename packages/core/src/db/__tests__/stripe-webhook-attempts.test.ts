// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { STRIPE_WEBHOOK_RESULTS } from "@breatic/shared";
import * as schema from "@core/db/schema.js";

describe("Stripe webhook attempt schema", () => {
  it("declares the controlled record fields and stable partial indexes", () => {
    const config = getTableConfig(schema.stripeWebhookAttempts);
    expect(config.name).toBe("stripe_webhook_attempts");
    expect(config.columns.map(column => column.name)).toEqual([
      "id", "event_id", "event_type", "livemode", "account_id", "endpoint_id",
      "connected_account_id", "environment", "received_at", "finished_at",
      "response_status", "result", "created_at", "updated_at", "deleted_at",
    ]);
    expect(config.indexes.map(index => index.config.name)).toEqual([
      "stripe_webhook_attempts_received_idx", "stripe_webhook_attempts_event_idx",
    ]);
    expect(config.indexes.every(index => index.config.where !== undefined)).toBe(true);
  });

  it("renders the completion constraint without bind parameters and agrees with its migration", () => {
    const config = getTableConfig(schema.stripeWebhookAttempts);
    expect(config.checks).toHaveLength(1);
    const rendered = new PgDialect().sqlToQuery(config.checks[0]!.value);
    expect(rendered.params).toEqual([]);
    expect(rendered.sql).toContain('"finished_at" is null');
    expect(rendered.sql).toContain('"finished_at" is not null');
    expect(rendered.sql).toContain('"response_status" is not null');
    expect(rendered.sql).toContain('"result" is not null');
    const migration = readFileSync(resolve(import.meta.dirname, "../migrations/0103_stripe_webhook_attempts.sql"), "utf8");
    for (const result of STRIPE_WEBHOOK_RESULTS) {
      expect(rendered.sql).toContain(`'${result}'`);
      expect(migration).toContain(`'${result}'`);
    }
    expect([...migration.matchAll(/'(credits_[a-z_]+|membership_[a-z_]+|refund_[a-z_]+|ignored|handler_exception)'/g)].map(match => match[1])).toEqual([...STRIPE_WEBHOOK_RESULTS]);
    expect(migration).toContain("response_status IS NOT NULL");
    expect(migration).toContain("result IS NOT NULL");
    expect(migration).toContain("BETWEEN 100 AND 599");
  });
});
