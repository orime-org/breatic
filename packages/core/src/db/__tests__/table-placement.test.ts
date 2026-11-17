// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every table in the product schema says where its rows live: only in the
 * global region, in each region for its own Studios, or in both by row. A new
 * table that is not placed fails here before it can be read from the wrong
 * database.
 */

import { describe, it, expect } from "vitest";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@core/db/schema.js";
import { RETIRED_TABLES, TABLE_PLACEMENT } from "@core/db/table-placement.js";

const schemaTables: string[] = Object.values(schema as Record<string, unknown>)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table));

describe("table placement", () => {
  it("places every table in the product schema", () => {
    const unplaced = schemaTables.filter((name) => !(name in TABLE_PLACEMENT));
    expect(unplaced).toEqual([]);
  });

  it("places no table that the schema does not define, besides the retired ones", () => {
    const unknown = Object.keys(TABLE_PLACEMENT).filter((name) => !schemaTables.includes(name) && !RETIRED_TABLES.includes(name));
    expect(unknown).toEqual([]);
  });

  it("keeps every retired table out of the schema and away from other regions", () => {
    for (const name of RETIRED_TABLES) {
      expect(schemaTables).not.toContain(name);
      expect(TABLE_PLACEMENT[name]).toBe("global");
    }
  });

  it("uses only the three placements", () => {
    const values = new Set(Object.values(TABLE_PLACEMENT));
    for (const value of values) expect(["global", "regional", "both"]).toContain(value);
  });

  it("keeps accounts, payments and the credit ledger global", () => {
    for (const name of ["users", "subscriptions", "payments", "credit_lots", "credit_ledger", "studio_credit_debts", "credit_holds"]) {
      expect(TABLE_PLACEMENT[name]).toBe("global");
    }
  });

  it("keeps accounts' provider keys and model upstream choices global, with the accounts (inner#1953)", () => {
    for (const name of ["account_provider_keys", "account_model_upstreams"]) {
      expect(schemaTables).toContain(name);
      expect(TABLE_PLACEMENT[name]).toBe("global");
    }
  });

  it("keeps Studio content regional", () => {
    for (const name of ["studios", "studio_members", "projects", "project_members", "studio_assets", "tasks", "credit_charge_requests"]) {
      expect(TABLE_PLACEMENT[name]).toBe("regional");
    }
  });

  it("splits notifications and milestones by row", () => {
    expect(TABLE_PLACEMENT.notifications).toBe("both");
    expect(TABLE_PLACEMENT.analytics_milestones).toBe("both");
  });
});
