// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Database wait limits (#1435, #1047): how long a query may wait for a pooled
 * connection, and how long opening a connection may take, before either fails.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, it, expect } from "vitest";
import { MONOREPO_ROOT } from "@core/config/env.js";
import { databaseConfigSchema, getDatabaseTimeouts } from "@core/config/database.js";
import { createPgClient } from "@core/db/client.js";

const clients: { end: (o: { timeout: number }) => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.end({ timeout: 0 })));
});

describe("database config", () => {
  it("parses the shipped config/database.yaml", () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, "config/database.yaml"), "utf-8"));
    expect(databaseConfigSchema.parse(raw).pool).toEqual({ connect_timeout_s: 30, queue_timeout_s: 30 });
  });

  it("falls back to 30 seconds for each limit when the file names none", () => {
    expect(databaseConfigSchema.parse({}).pool).toEqual({ connect_timeout_s: 30, queue_timeout_s: 30 });
  });

  it.each([0, -1, 1.5])("rejects a limit of %s", (value) => {
    expect(databaseConfigSchema.safeParse({ pool: { queue_timeout_s: value } }).success).toBe(false);
    expect(databaseConfigSchema.safeParse({ pool: { connect_timeout_s: value } }).success).toBe(false);
  });

  it("gives every pool built by createPgClient both limits and v3 parameter typing", () => {
    const sql = createPgClient("postgres://user:pw@localhost:1/none", { name: "config-test" });
    clients.push(sql);
    const { connectTimeoutS, queueTimeoutS } = getDatabaseTimeouts();
    expect(sql.options).toMatchObject({ connect_timeout: connectTimeoutS, queue_timeout: queueTimeoutS, infer: true });
  });

  it("lets a caller override a limit", () => {
    const sql = createPgClient("postgres://user:pw@localhost:1/none", { name: "config-test", queue_timeout: 1 });
    clients.push(sql);
    expect(sql.options).toMatchObject({ queue_timeout: 1 });
  });
});
