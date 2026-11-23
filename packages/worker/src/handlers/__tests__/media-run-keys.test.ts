// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A media run on the keys its task was submitted with (inner#1953): the account's media key set and the key set of
 * the language-model step inside the run reach every call to provider (plan, send, poll, recover), the clone cache
 * is read and written for the owner of the keys the run uses, and a failure of an account's key ends the run with a
 * code naming the upstream and why, never a retry on our key.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@breatic/core", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { readTaskFailure } from "@breatic/shared";
import { NoUpstreamAvailable, UpstreamTaskFailed, type KeySet } from "@breatic/provider";
import type { MediaAnswer, MediaRunner, MediaTicket } from "@breatic/provider/media";

import { MediaRunFailed, runMedia, type MediaRun, type MediaRunDeps } from "@worker/handlers/media-run.js";
import { StillRunning } from "@worker/handlers/still-running.js";

const NONE = { clones: [], retiredClones: [], warnings: [] };
const LATER = Date.now() + 3_600_000;
const KEYS: KeySet = { owner: "account", keyOf: (u: string) => (u === "fal" ? "acct-fal" : undefined) };
const LLM_KEYS: KeySet = { owner: "account", keyOf: (u: string) => (u === "openrouter" ? "acct-or" : undefined) };
const ACCOUNT = "user-admin-1";

const ticket = (version: number, phase: "send" | "running"): MediaTicket => ({ version, phase, steps: [{ kind: "generate", status: phase === "send" ? "pending" : "submitted" }] });
const send = (t: MediaTicket): MediaAnswer => ({ state: "send", ticket: t, step: { kind: "generate" }, ...NONE });
const running = (t: MediaTicket): MediaAnswer => ({ state: "running", ticket: t, askAgainAt: LATER, ...NONE });

/**
 * A run on the account's keys and its dependencies over a fake runner and store.
 * @param held - What the task row holds.
 * @param held.ticket - Its ticket.
 * @param held.sendingAt - Its sending mark.
 * @param runner - The runner's answers.
 * @returns The run, its deps and the clone calls.
 */
function setup(held: { ticket: MediaTicket | null; sendingAt: Date | null }, runner: Partial<MediaRunner>): { run: MediaRun; deps: MediaRunDeps; liveClonesFor: ReturnType<typeof vi.fn>; recordClone: ReturnType<typeof vi.fn> } {
  const liveClonesFor = vi.fn(async () => []);
  const recordClone = vi.fn(async () => true);
  const deps: MediaRunDeps = {
    runner: { plan: vi.fn(), send: vi.fn(), poll: vi.fn(), recover: vi.fn(), ticketFromLegacy: vi.fn(), abandon: vi.fn(() => ({ costs: [] })), ...runner },
    tickets: {
      getProviderTicket: async () => ({ ticket: held.ticket as never, sendingAt: held.sendingAt }),
      storeTicket: async () => true,
      markSending: async () => undefined,
      clearSending: async () => undefined,
    },
    clones: { liveClonesFor, recordClone, retireClone: vi.fn(async () => undefined) },
    sourceOf: async () => ({ sha256: "sha-a", durationSeconds: null }),
    legacy: async () => ({}),
    readingPlace: (async <T>(work: () => Promise<T>): Promise<T> => work()),
    pollIntervalMs: 1_000,
  };
  const run = {
    taskId: "task-1",
    studioId: "studio-1",
    model: "seedream-5",
    displayName: "Seedream 5",
    input: vi.fn(async () => ({ prompt: "a fox", params: { image: "https://cdn/a.png" } })),
    route: { mode: "upstream", upstream: "fal" },
    deadlineAt: LATER,
    outputCount: 1,
    lastAttempt: false,
    keys: KEYS,
    llmKeys: LLM_KEYS,
    cloneOwner: ACCOUNT,
  } as unknown as MediaRun;
  return { run, deps, liveClonesFor, recordClone };
}

/**
 * A key failure as provider reports it on a failed answer.
 * @param kind - The kind.
 * @param extra - Why, and the upstream.
 * @returns The reason.
 */
const keyFailure = (kind: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(kind), { kind, ...extra });

describe("the keys reach every call to provider", () => {
  it("plans with the media and LLM key sets, and sends with both", async () => {
    const plan = vi.fn(async (..._args: unknown[]) => send(ticket(1, "send")));
    const sendFn = vi.fn(async (..._args: unknown[]) => running(ticket(2, "running")));
    const { run, deps } = setup({ ticket: null, sendingAt: null }, { plan, send: sendFn });

    await expect(runMedia(run, deps)).rejects.toBeInstanceOf(StillRunning);

    expect(plan.mock.calls[0]![3]).toMatchObject({ keys: KEYS, llmKeys: LLM_KEYS });
    expect(sendFn.mock.calls[0]![1]).toMatchObject({ keys: KEYS, llmKeys: LLM_KEYS });
  });

  it("polls a running ticket with both key sets", async () => {
    const poll = vi.fn(async (..._args: unknown[]) => running(ticket(3, "running")));
    const { run, deps } = setup({ ticket: ticket(2, "running"), sendingAt: null }, { poll });

    await expect(runMedia(run, deps)).rejects.toBeInstanceOf(StillRunning);
    expect(poll.mock.calls[0]![1]).toMatchObject({ keys: KEYS, llmKeys: LLM_KEYS });
  });

  it("recovers a cut send with both key sets", async () => {
    const recover = vi.fn(async (..._args: unknown[]) => running(ticket(3, "running")));
    const { run, deps } = setup({ ticket: ticket(2, "send"), sendingAt: new Date() }, { recover });

    await expect(runMedia(run, deps)).rejects.toBeInstanceOf(StillRunning);
    expect(recover.mock.calls[0]![1]).toMatchObject({ keys: KEYS, llmKeys: LLM_KEYS });
  });

  it("hands provider no key set for a run on our keys", async () => {
    const plan = vi.fn(async (..._args: unknown[]) => send(ticket(1, "send")));
    const sendFn = vi.fn(async (..._args: unknown[]) => running(ticket(2, "running")));
    const { run, deps } = setup({ ticket: null, sendingAt: null }, { plan, send: sendFn });
    const ours = { ...run, keys: undefined, llmKeys: undefined, cloneOwner: "deployment" } as unknown as MediaRun;

    await expect(runMedia(ours, deps)).rejects.toBeInstanceOf(StillRunning);
    expect((plan.mock.calls[0]![3] as Record<string, unknown>).keys).toBeUndefined();
    expect((sendFn.mock.calls[0]![1] as Record<string, unknown>).keys).toBeUndefined();
  });
});

describe("the clone cache is kept per key owner", () => {
  it("reads and writes the clones of the account whose key runs the media", async () => {
    const plan = vi.fn(async (): Promise<MediaAnswer> => ({
      ...send(ticket(1, "send")),
      clones: [{ upstream: "fal", kind: "voice", sourceKey: "sha-a", upstreamId: "v-1" }],
    }));
    const { run, deps, liveClonesFor, recordClone } = setup({ ticket: null, sendingAt: null }, { plan, send: vi.fn(async () => running(ticket(2, "running"))) });

    await expect(runMedia(run, deps)).rejects.toBeInstanceOf(StillRunning);
    expect(liveClonesFor).toHaveBeenCalledWith("studio-1", ["sha-a"], ACCOUNT);
    expect(recordClone).toHaveBeenCalledWith("studio-1", "fal", "voice", "sha-a", "v-1", ACCOUNT);
  });
});

describe("a failure of an account's key ends the run with its own code", () => {
  /**
   * Run a send that answers failed with a reason.
   * @param reason - The failed answer's reason.
   * @returns What the run threw.
   */
  async function failedWith(reason: Error): Promise<MediaRunFailed> {
    const { run, deps } = setup({ ticket: ticket(1, "send"), sendingAt: null }, {
      send: vi.fn(async (): Promise<MediaAnswer> => ({ state: "failed", reason, costs: [], ...NONE }) as unknown as MediaAnswer),
    });
    const thrown = await runMedia(run, deps).then(() => undefined, (err: unknown) => err);
    expect(thrown).toBeInstanceOf(MediaRunFailed);
    return thrown as MediaRunFailed;
  }

  it.each(["invalid", "no_balance", "model_not_found", "rate_limited"])("names the upstream and why the key failed (%s)", async (why) => {
    const failed = await failedWith(keyFailure("account_key_failed", { reason: why, upstream: "fal" }));
    expect(readTaskFailure(failed.message)).toMatchObject({ reason: "account_key_failed", model: "Seedream 5", upstream: "fal", keyReason: why });
  });

  it("names a key the account replaced or deleted while the run was going", async () => {
    const failed = await failedWith(Object.assign(new NoUpstreamAvailable("seedream-5", []), { cause: keyFailure("account_key_missing") }));
    expect(readTaskFailure(failed.message)).toMatchObject({ reason: "account_key_missing", model: "Seedream 5" });
  });

  it("names the upstream it could not reach", async () => {
    const failed = await failedWith(keyFailure("upstream_unavailable", { upstream: "sandbase" }));
    expect(readTaskFailure(failed.message)).toMatchObject({ reason: "upstream_unavailable", upstream: "sandbase" });
  });

  it("keeps an upstream's own task failure in its own words", async () => {
    const failed = await failedWith(new UpstreamTaskFailed("fal", "nsfw"));
    expect(failed.message).toBe("fal task failed: nsfw");
  });
});
