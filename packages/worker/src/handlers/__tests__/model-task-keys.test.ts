// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A model run on the keys its task was submitted with (inner#1953). The task row holds only the ids of the account
 * key rows it runs on (`key_id` for the media, `llm_key_id` for a language-model step inside the run), never a key;
 * each pickup reads the keys by those ids and hands them to the run. A row replaced or deleted since then ends the
 * run as `account_key_missing` before anything is sent, never on our key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type { KeySet } from "@breatic/provider";

const h = vi.hoisted(() => ({
  runMedia: vi.fn(),
  rewrittenPrompt: vi.fn(),
  keysById: vi.fn(),
  getByIdInternal: vi.fn(),
  listSteps: vi.fn(),
  resolveOwnerStudioId: vi.fn(),
  recordModelCall: vi.fn(),
  createUsageRecorder: vi.fn(),
  handOffLookups: vi.fn(async () => undefined),
  callEnded: vi.fn(),
  handOff: vi.fn(async () => undefined),
  watchModelCalls: vi.fn(),
}));

vi.mock("@breatic/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getWorkerConfig: () => ({ poll_interval: 5000 }),
  getUnderstandConfig: () => ({ max_media_bytes: 20_000_000 }),
  getStorageAdapter: async () => ({ keyFromUrl: () => null }),
}));
vi.mock("@breatic/domain", () => ({
  provider: () => ({ name: "the-provider", llm: { name: "the-llm" } }),
  keysById: h.keysById,
  taskRepo: { getProviderTicket: vi.fn() },
  taskService: { getByIdInternal: h.getByIdInternal },
  upstreamStepRepo: { listSteps: h.listSteps },
  upstreamCloneRepo: { name: "upstreamCloneRepo" },
  assetService: { resolveOwnerStudioId: h.resolveOwnerStudioId },
  assetRepo: { findLiveByStorageKey: vi.fn() },
  createUsageRecorder: h.createUsageRecorder,
  handOffLookups: h.handOffLookups,
  watchModelCalls: h.watchModelCalls,
}));
vi.mock("@breatic/shared", async (importOriginal) => ({ ...(await importOriginal<typeof sharedModule>()) }));
vi.mock("@breatic/provider/media", () => ({ createMediaRunner: () => ({ name: "runner" }) }));
vi.mock("@worker/handlers/media-run.js", () => ({ runMedia: h.runMedia }));
vi.mock("@worker/handlers/prompt-rewrite.js", () => ({
  rewrittenPrompt: h.rewrittenPrompt,
  REWRITTEN_MODELS: new Set(["nano-banana-2"]),
  REWRITE_MODEL: "deepseek/deepseek-chat",
}));
vi.mock("@worker/handlers/understand-slots.js", () => ({ withUnderstandSlot: vi.fn() }));
vi.mock("@worker/handlers/model-params.js", () => ({
  validateModelParams: (_m: string, model: string, params: Record<string, unknown>): [string, Record<string, unknown>] => [model, params],
  entryOf: (_m: string, model: string): unknown => ({ name: model, takes_prompt: true, params: { resolution: { fill: "panel" } } }),
}));

import { runModelTask, type ModelTask } from "@worker/handlers/model-task.js";

const MEDIA_KEY_ID = "11111111-1111-4111-8111-111111111111";
const LLM_KEY_ID = "22222222-2222-4222-8222-222222222222";
const MEDIA_KEYS: KeySet = { owner: "account", keyOf: (u: string) => (u === "fal" ? "acct-fal" : undefined) };
const LLM_KEYS: KeySet = { owner: "account", keyOf: (u: string) => (u === "openrouter" ? "acct-or" : undefined) };

const TASK = {
  taskId: "task-1",
  modality: "image",
  model: "seedream-5",
  params: { prompt: "a fox", route: { mode: "upstream", upstream: "fal" } },
  projectId: "p1",
  outputCount: 1,
  deadlineAt: Date.now() + 60_000,
  lastAttempt: false,
  actorUserId: "user-1",
  keyId: MEDIA_KEY_ID,
  llmKeyId: LLM_KEY_ID,
} as unknown as ModelTask;

beforeEach(() => {
  vi.clearAllMocks();
  h.runMedia.mockResolvedValue({ outputs: [], costs: [], servedBy: "fal", passedOverCosts: [] });
  h.resolveOwnerStudioId.mockResolvedValue("studio-1");
  h.rewrittenPrompt.mockResolvedValue({ prompt: "rewritten" });
  h.listSteps.mockResolvedValue([]);
  h.watchModelCalls.mockReturnValue({ callEnded: h.callEnded, handOff: h.handOff, served: () => "openrouter" });
  h.keysById.mockImplementation(async (id: string | null) => {
    if (id === MEDIA_KEY_ID) return { keys: MEDIA_KEYS };
    if (id === LLM_KEY_ID) return { keys: LLM_KEYS };
    return null;
  });
});

describe("the keys a model run uses", () => {
  it("reads the media and LLM keys by the row ids the task holds and hands them to the run", async () => {
    await runModelTask(TASK);

    expect(h.keysById).toHaveBeenCalledWith(MEDIA_KEY_ID);
    expect(h.keysById).toHaveBeenCalledWith(LLM_KEY_ID);
    const [run] = h.runMedia.mock.calls[0] as [Record<string, unknown>];
    expect(run).toMatchObject({ keys: MEDIA_KEYS, llmKeys: LLM_KEYS, cloneOwner: MEDIA_KEY_ID, route: { mode: "upstream", upstream: "fal" } });
  });

  it("runs on our keys, owning its clones as the deployment, when the task holds no key row", async () => {
    await runModelTask({ ...TASK, keyId: null, llmKeyId: null });

    const [run] = h.runMedia.mock.calls[0] as [Record<string, unknown>];
    expect(run.keys).toBeUndefined();
    expect(run.llmKeys).toBeUndefined();
    expect(run.cloneOwner).toBe("deployment");
  });

  it("runs the media on the account's key and the description on ours when only the media has a key row", async () => {
    await runModelTask({ ...TASK, llmKeyId: null });

    const [run] = h.runMedia.mock.calls[0] as [Record<string, unknown>];
    expect(run.keys).toBe(MEDIA_KEYS);
    expect(run.llmKeys).toBeUndefined();
  });

  it("rewrites Nano Banana 2's prompt on the task's LLM keys", async () => {
    await runModelTask({ ...TASK, model: "nano-banana-2", params: { prompt: "a cat", resolution: "1k" } });
    const [run] = h.runMedia.mock.calls[0] as [{ input: (rows: object) => Promise<unknown> }];
    await run.input({});

    expect((h.rewrittenPrompt.mock.calls[0]![4] as { keys: KeySet }).keys).toBe(LLM_KEYS);
  });

  it("records the rewrite on the payer's OpenRouter key under the LLM key row, at once, through the shared watch", async () => {
    const pending = (): readonly unknown[] => [];
    const ended = { usage: { totalTokens: 9 }, providerMetadata: {} };
    h.rewrittenPrompt.mockImplementationOnce(async (_p: string, _q: unknown, _f: string, _d: number, account: { record: (b: object) => Promise<void> }) => {
      await account.record({ ended, pending });
      return { prompt: "{}" };
    });
    const settle = vi.fn(async () => 0);
    h.createUsageRecorder.mockReturnValue({ operation: { operationKey: "task:task-1" }, settle });
    await runModelTask({ ...TASK, model: "nano-banana-2", params: { prompt: "a cat", resolution: "1k" } });
    const [run] = h.runMedia.mock.calls[0] as [{ input: (rows: object) => Promise<{ prompt: string }> }];

    expect((await run.input({})).prompt).toBe("{}");
    expect(h.createUsageRecorder).toHaveBeenCalledWith(expect.objectContaining({ operationKey: "task:task-1", actorUserId: "user-1", keyId: LLM_KEY_ID }));
    expect(h.watchModelCalls).toHaveBeenCalledWith(expect.anything(), { model: "deepseek/deepseek-chat", description: "Task: prompt rewrite", keyId: LLM_KEY_ID }, pending, { name: "the-llm" });
    expect(h.callEnded).toHaveBeenCalledWith(ended);
    expect(h.handOff).toHaveBeenCalled();
    expect(settle).toHaveBeenCalled();
  });

  it("rewrites on our keys, recording nothing, when the task holds no LLM key row", async () => {
    await runModelTask({ ...TASK, llmKeyId: null, model: "nano-banana-2", params: { prompt: "a cat", resolution: "1k" } });
    const [run] = h.runMedia.mock.calls[0] as [{ input: (rows: object) => Promise<unknown> }];
    await run.input({});

    expect(h.rewrittenPrompt.mock.calls[0]![4]).toBeUndefined();
  });

  it("still runs when only the LLM key row is gone, and fails only when a step asks for that key", async () => {
    h.keysById.mockImplementation(async (id: string | null) => {
      if (id === MEDIA_KEY_ID) return { keys: MEDIA_KEYS };
      throw Object.assign(new Error("account key gone"), { kind: "account_key_missing", upstream: "openrouter" });
    });

    await runModelTask(TASK);

    const [run] = h.runMedia.mock.calls[0] as [{ keys: KeySet; llmKeys: KeySet }];
    expect(run.keys).toBe(MEDIA_KEYS);
    expect(run.llmKeys.owner).toBe("account");
    expect(() => run.llmKeys.keyOf("openrouter")).toThrow(expect.objectContaining({ kind: "account_key_missing" }));
  });

  it("ends the run as account_key_missing, sending nothing, when a key row was replaced or deleted", async () => {
    h.keysById.mockImplementation(async (id: string | null) => {
      if (id === MEDIA_KEY_ID) throw Object.assign(new Error("account key gone"), { kind: "account_key_missing" });
      return null;
    });

    const thrown = await runModelTask(TASK).then(() => undefined, (err: unknown) => err);
    const kinds: unknown[] = [];
    for (let c = thrown; typeof c === "object" && c !== null; c = (c as { cause?: unknown }).cause) kinds.push((c as { kind?: unknown }).kind);
    expect(kinds).toContain("account_key_missing");
    expect(h.runMedia).not.toHaveBeenCalled();
  });
});
