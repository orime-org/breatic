// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Database wait limits (#1435, #1047): a query that cannot get a pooled
 * connection, or a connection that cannot be opened, fails within its limit
 * instead of waiting for ever, and each such wait is reported once with the
 * state of the pools.
 */

import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createPgClient,
  db,
  initCore,
  onDatabaseWaitTimeout,
  type DatabaseWaitTimeout,
} from "@breatic/core";

initCore({ ...process.env, DB_POOL_SIZE: "2", PAYMENT_ENABLED: "false" });

type Pool = ReturnType<typeof createPgClient>;

const events: DatabaseWaitTimeout[] = [];
let stopListening: () => void = () => {};
const pools: Pool[] = [];

beforeAll(() => {
  stopListening = onDatabaseWaitTimeout((event) => events.push(event));
});
afterEach(async () => {
  events.length = 0;
  await Promise.all(pools.splice(0).map((p) => p.end({ timeout: 0 })));
});
afterAll(() => stopListening());

/**
 * A pool on the test database with one-second limits.
 * @param max - Pool size.
 * @param url - Connection URL; the test database by default.
 * @returns The pool, closed after the test.
 */
function smallPool(max: number, url = inject("DATABASE_URL")): Pool {
  const pool = createPgClient(url, { name: "wait-limit-test", max, queue_timeout: 1, connect_timeout: 1, onnotice: () => {} });
  pools.push(pool);
  return pool;
}

/**
 * A promise with its resolve function, for holding a connection until released.
 * @returns The gate and the function that opens it.
 */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * Let pending timers and diagnostics callbacks run.
 * @param ms - How long to wait.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("waiting for a pooled connection", () => {
  it("fails a query after the queue limit, reports it once, and serves the next query after release", async () => {
    const pool = smallPool(1);
    const held = gate();
    const holder = pool.begin(async (tx) => {
      await tx`select 1`;
      await held.wait;
    });
    await sleep(100);
    const started = Date.now();
    await expect(pool`select 2`).rejects.toMatchObject({ code: "QUEUE_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2_500);
    await sleep(50);
    expect(events.map((e) => e.code)).toEqual(["QUEUE_TIMEOUT"]);
    held.open();
    await holder;
    expect((await pool`select 3 as n`)[0]?.n).toBe(3);
  });

  it("reports a transaction that cannot get a connection once", async () => {
    const pool = smallPool(1);
    const held = gate();
    const holder = pool.begin(async (tx) => {
      await tx`select 1`;
      await held.wait;
    });
    await sleep(100);
    await expect(pool.begin((tx) => tx`select 2`)).rejects.toMatchObject({ code: "QUEUE_TIMEOUT" });
    await sleep(50);
    expect(events.map((e) => e.code)).toEqual(["QUEUE_TIMEOUT"]);
    held.open();
    await holder;
  });

  it("reports a pool query issued inside a transaction once, not again for the transaction", async () => {
    const pool = smallPool(1);
    await expect(
      pool.begin(async (tx) => {
        await tx`select 1`;
        return pool`select 2`;
      }),
    ).rejects.toMatchObject({ code: "QUEUE_TIMEOUT" });
    await sleep(50);
    expect(events.map((e) => e.code)).toEqual(["QUEUE_TIMEOUT"]);
  });

  it("times out a transaction while every connection runs a query, and reports it", async () => {
    const pool = smallPool(2);
    const warm = gate();
    const opened = [0, 1].map(() => pool.begin(async (tx) => {
      await tx`select 1`;
      await warm.wait;
    }));
    await sleep(200);
    warm.open();
    await Promise.all(opened);
    expect(pool.stats).toMatchObject({ connections: 2, leased: 0 });
    const busy = [pool`select pg_sleep(2.5)`.execute(), pool`select pg_sleep(2.5)`.execute()];
    await sleep(200);
    await expect(pool.begin((tx) => tx`select 1`)).rejects.toMatchObject({ code: "QUEUE_TIMEOUT" });
    await Promise.all(busy);
    expect(events.map((e) => e.code)).toContain("QUEUE_TIMEOUT");
  });

  it("reports the main pool's size and state when its own connections are all held", async () => {
    const held = gate();
    const holders = [0, 1].map(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        await held.wait;
      }),
    );
    await sleep(200);
    await expect(db.execute(sql`select 2`)).rejects.toThrow();
    await sleep(50);
    const event = events.find((e) => e.code === "QUEUE_TIMEOUT");
    expect(event?.pools.main).toMatchObject({ max: 2, connections: 2, leased: 2, idle: 0 });
    held.open();
    await Promise.all(holders);
  }, 45_000);
});

describe("opening a connection", () => {
  let proxy: Server;
  let proxyPort = 0;
  let mode: "swallow" | "forward" = "swallow";
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    const target = new URL(inject("DATABASE_URL"));
    proxy = createServer((client) => {
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.on("error", () => {});
      if (mode === "swallow") return;
      const upstream = tcpConnect(Number(target.port), target.hostname);
      upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    proxyPort = typeof address === "object" && address ? address.port : 0;
  });
  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  it("fails within the limits while the database does not answer, reports each attempt once, and reconnects once it answers", async () => {
    mode = "swallow";
    const target = new URL(inject("DATABASE_URL"));
    target.hostname = "127.0.0.1";
    target.port = String(proxyPort);
    const pool = smallPool(2, target.toString());
    const started = Date.now();
    const first = [pool`select 1`, pool`select 2`].map((q) => q.then(() => null, (e: { code?: string }) => e.code));
    await sleep(500);
    const third = pool`select 3`.then(() => null, (e: { code?: string }) => e.code);
    const codes = await Promise.all([...first, third]);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(codes.every((c) => c === "QUEUE_TIMEOUT" || c === "CONNECT_TIMEOUT")).toBe(true);
    await sleep(50);
    const connectEvents = events.filter((e) => e.code === "CONNECT_TIMEOUT");
    expect(connectEvents.length).toBeGreaterThan(0);
    expect(connectEvents.length).toBeLessThanOrEqual(3);

    mode = "forward";
    for (const s of sockets) s.destroy();
    let answered: number | undefined;
    for (let i = 0; i < 40 && answered === undefined; i++) {
      answered = await pool`select 4 as n`.then((rows) => rows[0]?.n as number, () => undefined);
      if (answered === undefined) await sleep(250);
    }
    expect(answered).toBe(4);
  }, 30_000);
});
