// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A turn paused at a card and resumed by the user's answer runs on the key row its paused segment ran on (inner#1953),
 * through the real route, run and store: the segment that asked records the key row's id beside the upstream that
 * served it, the answer's route reads it back with the model, and the resumed segment reads that row by id rather than
 * asking whose keys the Studio runs on now. Once the row is replaced or deleted, the resumed segment ends failed as
 * `account_key_missing` on the run's stream, asking no model and moving to no other key. Whether the resumed segment can
 * be served is judged on that row's keys, so a turn on the payer's key resumes where the deployment has none.
 *
 * The model is a double and the key reads are stubs at the domain boundary; the route, the queue, the run and the
 * conversation store are real, as in `chat-run-entrances.integration.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, inject, vi } from "vitest";

const ACCOUNT_KEY = "sk-or-v1-resumed-account-key-never-stored";

const h = vi.hoisted(() => ({
  calls: [] as Array<() => unknown[]>,
  count: 0,
  resolveKeys: vi.fn(),
  keysById: vi.fn(),
}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { assemblyProvider, fakeProvider } = await import("../helpers/fake-provider.js");
  actual.initProvider(assemblyProvider());
  const { MockLanguageModelV4 } = await import("ai/test");
  const { FINISHED } = await import("../helpers/model-double.js");
  return {
    ...actual,
    resolveKeys: h.resolveKeys,
    keysById: h.keysById,
    provider: fakeProvider(() =>
      new MockLanguageModelV4({
        doStream: async () => {
          const i = h.count++;
          const parts = (h.calls[i] ?? (() => [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "done" },
            { type: "text-end", id: "t" },
            FINISHED,
          ]))();
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const p of parts) controller.enqueue(p as never);
                controller.close();
              },
            }),
          };
        },
      })),
  };
});

import type * as DomainModule from "@breatic/domain";
import postgres from "postgres";
import type { Hono } from "hono";
import { getRedis, initCore, loadLocales } from "@breatic/core";
import { initProvider, provider } from "@breatic/domain";
import { FINISHED_ASKING_FOR_A_TOOL } from "../helpers/model-double.js";
import { assemblyProvider, TEST_UPSTREAM } from "../helpers/fake-provider.js";
import { keysOf, seedOwner, sendAndRead, untilIdle, type Seeded } from "./chat-run-harness.js";

const ACCOUNT = { owner: "account" as const, keyOf: (upstream: string) => (upstream === "openrouter" ? ACCOUNT_KEY : undefined) };
const KEY_ROW = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  try {
    initCore(process.env);
  } catch {
    // Already initialised by a sibling suite in this worker.
  }
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A deployment with no key of its own for the upstream the turns are served by: only an account's key set serves it.
 */
function deployWithoutKeys(): void {
  initProvider({
    llm: {
      capabilities: async () => ({ pictures: false }),
      availability: (_model: string, use: "call" | "understand", keys?: { owner?: string }) => ({
        upstreams: use === "call" ? [{ upstream: TEST_UPSTREAM, weight: 0, configured: keys?.owner === "account", envVar: "TEST_UPSTREAM_KEY" }] : [],
      }),
      judgeAvailability: () => ({ upstreams: [] }),
    },
  } as never);
}

beforeEach(() => {
  initProvider(assemblyProvider());
  h.calls = [];
  h.count = 0;
  h.resolveKeys.mockReset();
  h.keysById.mockReset();
  h.resolveKeys.mockResolvedValue({ keys: ACCOUNT, keyId: KEY_ROW, route: { mode: "default" } });
  h.keysById.mockResolvedValue({ keys: ACCOUNT });
});

/**
 * A conversation whose turn, run on the payer's key row, stopped at a questionnaire.
 * @param toolCallId - The card's call id.
 * @returns The conversation.
 */
async function pausedOnAccountKey(toolCallId: string): Promise<Seeded> {
  const who = await seedOwner(sql, app);
  h.calls = [() => [
    {
      type: "tool-call",
      toolCallId,
      toolName: "ask_user",
      input: JSON.stringify({ questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] }),
    },
    FINISHED_ASKING_FOR_A_TOOL,
  ]];
  await sendAndRead(app, who.cookie, { project_id: who.projectId, conversation_id: who.conversationId, message: "ask me" });
  await untilIdle(who.conversationId);
  expect(await getRedis().get(keysOf(who.conversationId).awaiting)).toBe(toolCallId);
  h.calls = [];
  h.count = 0;
  h.resolveKeys.mockClear();
  (provider().llm.prepare as unknown as { mockClear: () => void }).mockClear();
  return who;
}

/**
 * Answer the questionnaire and read the run it opens.
 * @param who - Whose conversation.
 * @param toolCallId - The card's call id.
 * @returns The status and the run's frames.
 */
async function answer(who: Seeded, toolCallId: string): Promise<{ status: number; chunks: Record<string, unknown>[] }> {
  return sendAndRead(app, who.cookie, {
    message: "",
    project_id: who.projectId,
    conversation_id: who.conversationId,
    answer: { toolCallId, answers: [{ index: 0, selected: ["9:16"] }] },
  });
}

/**
 * The key set the last prepared model call was handed.
 * @returns The fourth argument of the last `provider().llm.prepare` call.
 */
function preparedKeys(): unknown {
  const prepare = provider().llm.prepare as unknown as { mock: { calls: unknown[][] } };
  return prepare.mock.calls.at(-1)?.[3];
}

describe("a turn resumed by an answer to its card", () => {
  it("runs on the key row its paused segment ran on, read by id rather than resolved again", async () => {
    const who = await pausedOnAccountKey("call-resume-1");

    const { status } = await answer(who, "call-resume-1");

    expect(status).toBe(200);
    expect(h.keysById).toHaveBeenCalledWith(KEY_ROW);
    expect(h.resolveKeys).not.toHaveBeenCalled();
    expect(h.count).toBe(1);
    expect(preparedKeys()).toBe(ACCOUNT);
  });

  it("stores no key in the conversation, only the key row's id", async () => {
    const who = await pausedOnAccountKey("call-resume-2");
    await answer(who, "call-resume-2");

    const rows = await sql<{ for_model: unknown; parts: unknown }[]>`
      SELECT for_model, parts FROM conversation_messages WHERE conversation_id = ${who.conversationId}
    `;
    expect(JSON.stringify(rows)).toContain(KEY_ROW);
    expect(JSON.stringify(rows)).not.toContain(ACCOUNT_KEY);
  });

  it("ends failed as account_key_missing once that row is replaced or deleted, asking no model and using no other key", async () => {
    const who = await pausedOnAccountKey("call-resume-3");
    h.keysById.mockRejectedValue(Object.assign(new Error("the key row is gone"), { kind: "account_key_missing" }));

    const { chunks } = await answer(who, "call-resume-3");

    expect(h.keysById).toHaveBeenCalledWith(KEY_ROW);
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "data-failed",
      data: expect.objectContaining({ reason: "account_key_missing" }),
    }));
    expect(h.count).toBe(0);
    expect(h.resolveKeys).not.toHaveBeenCalled();
  });

  it("resumes on the payer's key where the deployment has no key for the upstream it stays on", async () => {
    const who = await pausedOnAccountKey("call-resume-4");
    deployWithoutKeys();

    const { status } = await answer(who, "call-resume-4");

    expect(status).toBe(200);
    expect(h.keysById).toHaveBeenCalledWith(KEY_ROW);
    expect(h.count).toBe(1);
    expect(preparedKeys()).toBe(ACCOUNT);
  });
});
