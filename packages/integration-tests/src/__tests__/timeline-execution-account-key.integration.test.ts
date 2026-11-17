// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Timeline web-animation execution accepted on the payer's OpenRouter key (inner#1953): acceptance records the key
 * row's id on the execution (`llm_key_id`), never the key. The worker reads the key by that id: the job's plan is made
 * on the account's keys and its stored step never holds the key; the model calls the report carries are recorded under
 * the key row at no credits and are not part of any charge; a pending call's lookup is queued with the key row's id and
 * uncharged. Once the row is replaced or deleted, the next pickup fails the execution as `account_key_missing` without
 * submitting, and never moves it to the deployment's key.
 *
 * Real database; the ingest Worker is the suite's stand-in, as in `timeline-execution-worker.integration.test.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

const settle = vi.hoisted(() => vi.fn(async (_requestId: string): Promise<Record<string, unknown> | null> => null));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, creditLotService: { ...actual.creditLotService, settleCharge: settle } };
});

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_count: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import type * as DomainModule from "@breatic/domain";
import { createHash, randomBytes } from "node:crypto";
import { accountProviderKeysRepo, createPgClient, createQueue, initCore, loadLocales, sealProviderKey } from "@breatic/core";
import { initProvider, provider, USAGE_LOOKUP_QUEUE } from "@breatic/domain";
import type { CostLookup } from "@breatic/provider";
import { runTimelineExecution } from "@worker/handlers/timeline/web-animation-execution.js";
import {
  CALLS,
  asJob,
  installFakeIngest,
  isWaiting,
  jobFor,
  json,
  manifest,
  read,
  report,
  seedExecution,
  serveManifest,
  type ExecutionFixture,
  type StartState,
} from "@integration-tests/__tests__/timeline-worker-fixtures.js";

const SECRET = randomBytes(32);
const RING = { current: "t1", keys: { t1: SECRET } };
const ACCOUNT_KEY = "sk-or-v1-timeline-account-key-never-stored";
const LOOKUP: CostLookup = { upstream: "openrouter", generationId: "gen-3" };

let sql: ReturnType<typeof createPgClient>;
const owned: string[] = [];

beforeAll(() => {
  initCore({ ...process.env, PROVIDER_KEY_SECRET_ID: "t1", PROVIDER_KEY_SECRETS: JSON.stringify({ t1: SECRET.toString("hex") }) });
  loadLocales();
  initProvider();
  sql = createPgClient(inject("DATABASE_URL"), { name: "timeline-account-key-driver", max: 4, prepare: false });
});

beforeEach(() => {
  settle.mockReset();
  settle.mockImplementation(async () => ({ billed: true, charged: "0", shortfall: "0", studioId: null, lotIds: [] }));
});

afterEach(async () => {
  await createQueue(USAGE_LOOKUP_QUEUE).remove(createHash("sha256").update(JSON.stringify(LOOKUP)).digest("hex"));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (owned.length > 0) await sql`UPDATE timeline_executions SET deleted_at = now() WHERE id = ANY(${owned}::uuid[])`;
  owned.length = 0;
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * Seed an execution accepted on its actor's own OpenRouter key.
 * @param state - Where it starts.
 * @returns The fixture and the key row's id.
 */
async function seedOnAccountKey(state: StartState): Promise<{ fx: ExecutionFixture; keyId: string }> {
  const fx = await seedExecution(sql, state);
  owned.push(fx.execution.id);
  const saved = await accountProviderKeysRepo.saveKey({ userId: fx.userId, upstream: "openrouter", ciphertext: sealProviderKey(ACCOUNT_KEY, RING), displayHint: "sk-or-…ored" });
  await sql`UPDATE timeline_executions SET llm_key_id = ${saved.id} WHERE id = ${fx.execution.id}`;
  return { fx, keyId: saved.id };
}

/**
 * Run one pickup; waiting for a later pickup is a normal outcome.
 * @param fx - The execution.
 */
async function pickUp(fx: ExecutionFixture): Promise<void> {
  try {
    await runTimelineExecution(asJob(jobFor(fx.execution.id)), "lock-token");
  } catch (err) {
    if (!isWaiting(err)) throw err;
  }
}

describe("an execution accepted on the payer's OpenRouter key", () => {
  it("plans its job on the account's keys and stores no key in the step it submits", async () => {
    const { fx } = await seedOnAccountKey("queued");
    const ingest = installFakeIngest(fx);
    const plan = vi.spyOn(provider().llm, "messagesPlan");

    await pickUp(fx);

    expect(plan).toHaveBeenCalledTimes(1);
    const keys = plan.mock.calls[0]?.[2] as { owner?: string; keyOf?: (upstream: string) => string | undefined } | undefined;
    expect(keys?.owner).toBe("account");
    expect(keys?.keyOf?.("openrouter")).toBe(ACCOUNT_KEY);
    const [stored] = await sql<{ steps: unknown }[]>`SELECT steps FROM timeline_executions WHERE id = ${fx.execution.id}`;
    expect(JSON.stringify(stored?.steps)).not.toContain(ACCOUNT_KEY);
    expect(JSON.stringify(ingest.calls)).not.toContain(ACCOUNT_KEY);
  });

  it("records its model calls under the key row at no credits, leaves them out of the charge, and queues the lookup uncharged", async () => {
    const { fx, keyId } = await seedOnAccountKey("running");
    const ingest = installFakeIngest(fx);
    const onAccount = { ...CALLS.completed, cost: { ...CALLS.completed.cost, payer: "account" } };
    const pending = { ...CALLS.interrupted, cost: { ...CALLS.interrupted.cost, payer: "account" } };
    ingest.read = () => json(report(fx, "done", { calls: [onAccount, CALLS.upstreamError, pending] }));
    await serveManifest(fx, manifest());

    await pickUp(fx);

    const rows = await sql<{ source: string; credits: string; key_id: string | null }[]>`
      SELECT source, credits::text AS credits, key_id FROM agent_usage_records WHERE operation_key = ${`timeline:${fx.execution.id}`}
    `;
    const models = rows.filter((row) => row.source === "model");
    expect(models.map((row) => [Number(row.credits), row.key_id])).toEqual([[0, keyId]]);
    const charged = await sql<{ amount: string }[]>`SELECT amount::text AS amount FROM credit_charge_requests WHERE reference_id = ${fx.execution.id}`;
    const others = rows.filter((row) => row.source !== "model").reduce((sum, row) => sum + Number(row.credits), 0);
    expect(charged.reduce((sum, row) => sum + Number(row.amount), 0)).toBeLessThanOrEqual(Math.ceil(others * 100) / 100);
    const job = await createQueue(USAGE_LOOKUP_QUEUE).getJob(createHash("sha256").update(JSON.stringify(LOOKUP)).digest("hex"));
    expect(job?.data).toEqual(expect.objectContaining({ lookup: LOOKUP, keyId, charge: false }));
    expect(JSON.stringify(job?.data)).not.toContain(ACCOUNT_KEY);
  });

  it("fails as account_key_missing without submitting once the key row is replaced", async () => {
    const { fx } = await seedOnAccountKey("queued");
    // Replacing the key clears the old row's sealed text at once.
    await accountProviderKeysRepo.saveKey({ userId: fx.userId, upstream: "openrouter", ciphertext: sealProviderKey("sk-or-v1-the-replacing-key", RING), displayHint: "sk-or-…ykey" });
    const ingest = installFakeIngest(fx);
    const plan = vi.spyOn(provider().llm, "messagesPlan");

    await pickUp(fx);

    expect(await read(fx.execution.id)).toMatchObject({ status: "failed", failureReason: "account_key_missing", failureUpstream: "openrouter" });
    expect(ingest.calls.filter((call) => call.route === "submit")).toEqual([]);
    expect(plan).not.toHaveBeenCalled();
  });

  it("fails with the upstream a failed report names when the Worker's key read was refused mid-run", async () => {
    const { fx } = await seedOnAccountKey("queued");
    const ingest = installFakeIngest(fx);
    await pickUp(fx);
    ingest.read = () => json(report(fx, "failed", { calls: [], failureReason: "account_key_missing", failureUpstream: "openrouter" }));

    await pickUp(fx);

    expect(await read(fx.execution.id)).toMatchObject({ status: "failed", failureReason: "account_key_missing", failureUpstream: "openrouter" });
  });
});
