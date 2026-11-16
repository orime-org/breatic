// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How a Document text tool run is counted, on real Postgres with payments on
 * (inner#1968, test spec area B: B-29 to B-33).
 *
 * One run is one operation, `text_tool:<operationKey>` under the key the
 * route mints. It counts when the run ends `done` and when the user stops it
 * (`aborted`, from the loop or from the catch), each counted before its event
 * is yielded, so a client that leaves right then does not undo it; counting
 * is a CAS, so the three count points together count at most once. A run
 * that ends in `error` is released, and its model fee is still charged.
 *
 * The model is a double that states its cost; `streamTextRetry` is replaced
 * only for the case that must throw while the request is already aborted.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, inject, vi } from "vitest";

/** What the model does next, and whether the stream itself throws after aborting. */
const script = vi.hoisted((): { mode: "say" | "error" | "open" | "throwAborted"; abort: (() => void) | null } => ({
  mode: "say",
  abort: null,
}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { assemblyProvider, fakeProvider } = await import("../helpers/fake-provider.js");
  actual.initProvider(assemblyProvider());
  const { MockLanguageModelV4 } = await import("ai/test");
  const { saying, finishedSpending } = await import("../helpers/model-double.js");
  return {
    ...actual,
    provider: fakeProvider(() =>
      new MockLanguageModelV4({
        doStream: async (asked) => {
          const spent = { ...finishedSpending(1000), providerMetadata: { test: { costUsd: 0.01 } } };
          const parts: unknown[] =
            script.mode === "error"
              ? [...saying("partial").slice(0, -1), spent, { type: "error", error: new Error("upstream broke off") }]
              : script.mode === "open"
                ? saying("partial").slice(0, 2)
                : [...saying("polished").slice(0, -1), spent];
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of parts) controller.enqueue(part as never);
                if (script.mode === "open") {
                  // The user stops it as soon as the first words are out.
                  script.abort?.();
                  asked.abortSignal?.addEventListener("abort", () => controller.close());
                  if (asked.abortSignal?.aborted === true) controller.close();
                } else controller.close();
              },
            }),
          };
        },
      })),
    streamTextRetry: (...args: Parameters<typeof actual.streamTextRetry>) => {
      if (script.mode !== "throwAborted") return actual.streamTextRetry(...args);
      return {
        fullStream: {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              script.abort?.();
              throw new Error("the stream broke as the request was aborted");
            },
          }),
        },
      } as unknown as ReturnType<typeof actual.streamTextRetry>;
    },
  };
});

import type * as DomainModule from "@breatic/domain";
import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import { db, initCore, loadLocales } from "@breatic/core";
import { operationService } from "@breatic/domain";
import { executeTextTool, type TextToolEvent } from "@server/modules/text-tool/text-tool.service.js";
import { PAYMENTS_ON, admit, ledgerRow, ledgerRows, request, seedAccount, used, type Account } from "./operation-counting-fixtures.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore(PAYMENTS_ON);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "operation-text-tool-counting-test" } });
  app = (await import("@server/app.js")).createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

beforeEach(() => {
  script.mode = "say";
  script.abort = null;
});

/**
 * Admit a text tool run the way the route does and start it.
 * @param a - The account.
 * @returns The run's events, its ledger key and its abort controller.
 */
async function begin(a: Account): Promise<{ run: AsyncGenerator<TextToolEvent>; key: string; controller: AbortController }> {
  const operationKey = crypto.randomUUID();
  const { key } = await admit(a, "text_tool", [], `text_tool:${operationKey}`);
  const controller = new AbortController();
  script.abort = () => controller.abort();
  const run = executeTextTool(a.userId, a.projectId, "polish", { document: "Hello there", selection: "Hello" }, controller.signal, operationKey);
  return { run, key, controller };
}

/**
 * Read a run to its end.
 * @param run - The run.
 * @returns The type of its last event.
 */
async function finish(run: AsyncGenerator<TextToolEvent>): Promise<string | undefined> {
  let last: string | undefined;
  for await (const event of run) last = event.type;
  return last;
}

describe("B-29 to B-33 a text tool run", () => {
  it("B-29 a run through the route that ends done counts once", async () => {
    const a = await seedAccount(sql);
    const res = await request(app, a.cookie, "POST", "/mini-tools/text", { tool: "polish", document: "Hello there", selection: "Hello", project_id: a.projectId });
    expect(res.status).toBe(200);
    await res.text();
    const rows = (await ledgerRows(sql, a)).filter((r) => r.kind === "text_tool");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "counted" });
    expect(rows[0]!.operation_key).toMatch(/^text_tool:/);
    expect(await used(a)).toBe(1);
  });

  it("B-30 a run the user stops counts, whether the stop is seen in the loop or in the catch", async () => {
    const a = await seedAccount(sql);
    script.mode = "open";
    const inLoop = await begin(a);
    expect(await finish(inLoop.run)).toBe("aborted");
    script.mode = "throwAborted";
    const inCatch = await begin(a);
    expect(await finish(inCatch.run)).toBe("aborted");
    expect((await ledgerRow(sql, inLoop.key))?.status).toBe("counted");
    expect((await ledgerRow(sql, inCatch.key))?.status).toBe("counted");
    expect(await used(a)).toBe(2);
  });

  it("B-31 a client that leaves the moment done is handed over leaves the run counted", async () => {
    const a = await seedAccount(sql);
    const { run, key } = await begin(a);
    for (;;) {
      const next = await run.next();
      if (next.done === true || next.value.type === "done") break;
    }
    await run.return(undefined);
    expect((await ledgerRow(sql, key))?.status).toBe("counted");
  });

  it("B-32 the three count points reached twice over count once, and the count time does not move", async () => {
    const a = await seedAccount(sql);
    const { key } = await admit(a, "text_tool", [], `text_tool:${crypto.randomUUID()}`);
    await db.transaction((tx) => operationService.countOperation(key, tx));
    const first = await ledgerRow(sql, key);
    for (let i = 0; i < 5; i++) await db.transaction((tx) => operationService.countOperation(key, tx));
    expect(await ledgerRow(sql, key)).toEqual(first);
    expect(await used(a)).toBe(1);
  });

  it("B-33 a run that ends in error is released and its model fee is still charged", async () => {
    const a = await seedAccount(sql);
    script.mode = "error";
    const { run, key } = await begin(a);
    expect(await finish(run)).toBe("error");
    expect((await ledgerRow(sql, key))?.status).toBe("released");
    const operationKey = key.slice("text_tool:".length);
    const fees = await sql`select kind from credit_charge_requests where reference_id = ${`texttool:${operationKey}`}`;
    expect(fees).toEqual([{ kind: "operation" }]);
    expect(await used(a)).toBe(0);
  });
});
