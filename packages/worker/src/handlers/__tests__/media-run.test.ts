// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One pickup of a media run through provider's tickets (inner#1743, design §12.2): every paid request goes out with a
 * ticket naming it stored first and the sending mark set; a pickup goes on from whatever the task holds — a ticket
 * running upstream is asked about, one whose send was cut is recovered, an older task is turned into a ticket, a new
 * one is planned; clones each answer made or retired are written back; a run still going goes back to the queue.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@breatic/core", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { DeadlinePassed } from "@breatic/shared";
import { DeadlinePassed as ProviderDeadlinePassed, SendNotAccepted, UpstreamTaskFailed, type Cost } from "@breatic/provider";
import type { MediaAnswer, MediaRunner, MediaTicket } from "@breatic/provider/media";
import { logger } from "@breatic/core";

import { MediaRunFailed, runMedia, type MediaRun, type MediaRunDeps } from "@worker/handlers/media-run.js";
import { StillRunning } from "@worker/handlers/still-running.js";

/** What the task row holds, as the fake store keeps it. */
interface Held {
  ticket: MediaTicket | null;
  sendingAt: Date | null;
  /** Every write, in order, for the cases that read the order. */
  log: string[];
}

const NONE = { clones: [], retiredClones: [], warnings: [] };
const LATER = Date.now() + 3_600_000;

/**
 * A ticket at one phase, with its next step for a send ticket.
 * @param version - Its version.
 * @param phase - Its phase.
 * @param kind - The next step's kind, for a send ticket.
 * @returns The ticket.
 */
function ticket(version: number, phase: "send" | "running", kind = "generate"): MediaTicket {
  return { version, phase, steps: [{ kind, status: phase === "send" ? "pending" : "submitted" }] };
}

/**
 * Answers of each kind.
 */
const send = (t: MediaTicket): MediaAnswer => ({ state: "send", ticket: t, step: { kind: ticketKind(t) }, ...NONE });
const running = (t: MediaTicket, askAgainAt = LATER): MediaAnswer => ({ state: "running", ticket: t, askAgainAt, ...NONE });
const COST: Cost = { state: "known", usd: 0.25, source: "billing" };
/** What the run hands provider once opened. */
const INPUT = { prompt: "hello", params: { audio: "https://cdn/a.mp3", speed: 1 } };
const done = (urls: string[]): MediaAnswer => ({ state: "done", outputs: urls.map((url) => ({ kind: "url" as const, url })), costs: [COST], servedBy: "fal", ...NONE });

/**
 * The kind of a fake ticket's next step.
 * @param t - The ticket.
 * @returns Its kind.
 */
function ticketKind(t: MediaTicket): "generate" | "describe" {
  return ((t.steps as { kind: "generate" | "describe" }[])[0]!.kind);
}

/**
 * A run and its dependencies over a fake runner and store.
 * @param held - What the task row holds before the pickup.
 * @param runner - The runner's answers.
 * @param legacy - What a task from before the provider layer left behind.
 * @returns The run, its dependencies and the store.
 */
function setup(held: Partial<Held> = {}, runner: Partial<MediaRunner> = {}, legacy = {}): { run: MediaRun; deps: MediaRunDeps; store: Held; recorded: unknown[][]; retired: unknown[][]; slot: ReturnType<typeof vi.fn> } {
  const store: Held = { ticket: null, sendingAt: null, log: [], ...held };
  const recorded: unknown[][] = [];
  const retired: unknown[][] = [];
  const slot = vi.fn(async <T>(work: () => Promise<T>): Promise<T> => work());
  const deps: MediaRunDeps = {
    runner: {
      plan: vi.fn(),
      send: vi.fn(),
      poll: vi.fn(),
      recover: vi.fn(),
      ticketFromLegacy: vi.fn(),
      abandon: vi.fn(() => ({ costs: [] })),
      ...runner,
    },
    tickets: {
      getProviderTicket: async () => ({ ticket: store.ticket as never, sendingAt: store.sendingAt }),
      storeTicket: async (_id, t) => {
        if (store.ticket !== null && store.ticket.version >= t.version) return false;
        store.ticket = t;
        store.log.push(`store ${t.version}`);
        return true;
      },
      markSending: async () => {
        store.sendingAt = new Date();
        store.log.push("mark");
      },
      clearSending: async () => {
        store.sendingAt = null;
        store.log.push("clear");
      },
    },
    clones: {
      liveClonesFor: async () => [{ upstream: "wavespeed", kind: "voice", sourceKey: "sha-a", upstreamId: "v-1" }],
      recordClone: async (...args) => {
        recorded.push(args);
        return true;
      },
      retireClone: async (...args) => {
        retired.push(args);
      },
    },
    sourceKeyOf: async (url) => (url === "https://cdn/a.mp3" ? "sha-a" : null),
    legacy: async () => legacy,
    readingPlace: slot as MediaRunDeps["readingPlace"],
    pollIntervalMs: 1_000,
  };
  const run: MediaRun = {
    taskId: "task-1",
    studioId: "studio-1",
    model: "voice-model",
    input: vi.fn(async () => INPUT),
    route: { mode: "default" },
    deadlineAt: LATER,
    outputCount: 1,
  };
  return { run, deps, store, recorded, retired, slot };
}

describe("a new task", () => {
  it("plans the run with its source keys and the live clones of its sources, then stores the ticket and marks the send before sending", async () => {
    const planned = ticket(1, "send");
    const sent = ticket(2, "running");
    const { run, deps, store } = setup({}, {
      plan: vi.fn(async () => send(planned)),
      send: vi.fn(async (t) => {
        expect(store.log).toEqual(["store 1", "mark"]);
        expect(t).toEqual(planned);
        return running(sent);
      }),
    });

    await expect(runMedia(run, deps)).rejects.toBeInstanceOf(StillRunning);

    expect(run.input).toHaveBeenCalledWith({});
    expect(deps.runner.plan).toHaveBeenCalledWith("voice-model", INPUT, run.route, {
      idempotencyKey: "task-1",
      sourceKeys: { "https://cdn/a.mp3": "sha-a" },
      clones: [{ upstream: "wavespeed", kind: "voice", sourceKey: "sha-a", upstreamId: "v-1" }],
      durations: {},
    });
    expect(store.log).toEqual(["store 1", "mark", "store 2", "clear"]);
    expect(store.ticket).toEqual(sent);
  });

  it("goes back to the queue until the time the running answer names", async () => {
    const { run, deps } = setup({}, { plan: vi.fn(async () => send(ticket(1, "send"))), send: vi.fn(async () => running(ticket(2, "running"), 12_345)) });

    await expect(runMedia(run, deps)).rejects.toMatchObject({ resumeAt: 12_345 });
  });

  it("sends each next step in the same pickup until the run is running or done", async () => {
    const { run, deps } = setup({}, {
      plan: vi.fn(async () => send(ticket(1, "send"))),
      send: vi.fn()
        .mockResolvedValueOnce(send(ticket(2, "send")))
        .mockResolvedValueOnce(done(["https://up/a.wav", "https://up/b.wav"])),
    });

    const result = await runMedia(run, deps);

    expect(deps.runner.send).toHaveBeenCalledTimes(2);
    // A generation writes as many outputs as it has nodes for.
    expect(result).toEqual({ outputs: [{ kind: "url", url: "https://up/a.wav" }], costs: [COST], servedBy: "fal" });
  });

  it("keeps the sending mark of a send that finished the run, for the caller to clear once the result is recorded", async () => {
    const { run, deps, store } = setup({}, { plan: vi.fn(async () => send(ticket(1, "send"))), send: vi.fn(async () => done(["https://up/a.wav"])) });

    await runMedia(run, deps);

    expect(store.sendingAt).not.toBeNull();
  });

  it("turns a task from before the provider layer into a ticket from what it left behind", async () => {
    const left = { providerTaskId: "pred-1" };
    const { run, deps } = setup({}, { ticketFromLegacy: vi.fn(async () => running(ticket(1, "running"))) }, left);

    await expect(runMedia(run, deps)).rejects.toBeInstanceOf(StillRunning);

    expect(run.input).toHaveBeenCalledWith(left);
    expect(deps.runner.ticketFromLegacy).toHaveBeenCalledWith("voice-model", INPUT, run.route, expect.objectContaining({ idempotencyKey: "task-1" }), left);
    expect(deps.runner.plan).not.toHaveBeenCalled();
  });
});

describe("a task holding a ticket", () => {
  it("asks about a running ticket, and asks once more past the deadline", async () => {
    const held = ticket(3, "running");
    const { run, deps } = setup({ ticket: held }, { poll: vi.fn(async () => done(["https://up/a.wav"])) });

    await runMedia(run, deps);
    expect(deps.runner.poll).toHaveBeenCalledWith(held, { deadlineAt: LATER, finalAsk: false });
    // A run already opened is not laid out again: a rewrite of its prompt would be paid for twice.
    expect(run.input).not.toHaveBeenCalled();

    await runMedia({ ...run, deadlineAt: Date.now() - 1 }, deps);
    expect(deps.runner.poll).toHaveBeenLastCalledWith(held, expect.objectContaining({ finalAsk: true }));
    expect(deps.runner.plan).not.toHaveBeenCalled();
  });

  it("recovers a send ticket whose send was cut, and sends nothing more when the step is found upstream", async () => {
    const held = ticket(3, "send");
    const { run, deps, store } = setup({ ticket: held, sendingAt: new Date() }, { recover: vi.fn(async () => running(ticket(4, "running"))) });

    await expect(runMedia(run, deps)).rejects.toBeInstanceOf(StillRunning);

    expect(deps.runner.recover).toHaveBeenCalledWith(held, { deadlineAt: LATER });
    expect(deps.runner.send).not.toHaveBeenCalled();
    expect(store.sendingAt).toBeNull();
  });

  it("sends a stored send ticket nobody was sending", async () => {
    const held = ticket(3, "send");
    const { run, deps } = setup({ ticket: held }, { send: vi.fn(async () => running(ticket(4, "running"))) });

    await expect(runMedia(run, deps)).rejects.toBeInstanceOf(StillRunning);

    expect(deps.runner.send).toHaveBeenCalledWith(held, { deadlineAt: LATER });
  });

  it("sends nothing new past the deadline", async () => {
    const { run, deps } = setup({ ticket: ticket(3, "send") });

    await expect(runMedia({ ...run, deadlineAt: Date.now() - 1 }, deps)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(deps.runner.send).not.toHaveBeenCalled();
  });

  it("stops without sending when another run stored a newer ticket meanwhile", async () => {
    const { run, deps, store } = setup({ ticket: ticket(5, "running") });
    deps.runner.poll = vi.fn(async () => {
      store.ticket = ticket(6, "running");
      return send(ticket(6, "send"));
    });

    await expect(runMedia(run, deps)).rejects.toBeInstanceOf(StillRunning);
    expect(deps.runner.send).not.toHaveBeenCalled();
  });
});

describe("a description step", () => {
  it("is sent inside a reading place, and its mark is written only once inside", async () => {
    const { run, deps, store, slot } = setup({ ticket: ticket(3, "send", "describe") }, {
      send: vi.fn(async () => {
        expect(slot).toHaveBeenCalledTimes(1);
        return running(ticket(4, "running"));
      }),
    });

    await expect(runMedia(run, deps)).rejects.toBeInstanceOf(StillRunning);

    expect(store.log[0]).toBe("mark");
  });

  it("leaves no mark when no reading place is free", async () => {
    const full = new StillRunning(LATER);
    const { run, deps, store } = setup({ ticket: ticket(3, "send", "describe") });
    deps.readingPlace = async () => {
      throw full;
    };

    await expect(runMedia(run, deps)).rejects.toBe(full);
    expect(store.sendingAt).toBeNull();
  });
});

describe("how a run ends", () => {
  it("clears the mark and rethrows a send the upstream did not take, for the queue to retry the same ticket", async () => {
    const refused = new SendNotAccepted("fal", new Error("503"));
    const { run, deps, store } = setup({ ticket: ticket(3, "send") }, { send: vi.fn(async () => Promise.reject(refused)) });

    await expect(runMedia(run, deps)).rejects.toBe(refused);
    expect(store.sendingAt).toBeNull();
  });

  it("ends at the task's deadline when provider says the deadline cut a call, the way every other call on the chain ends", async () => {
    const { run, deps } = setup({ ticket: ticket(3, "running") }, { poll: vi.fn(async () => Promise.reject(new ProviderDeadlinePassed(LATER))) });

    await expect(runMedia(run, deps)).rejects.toBeInstanceOf(DeadlinePassed);
  });

  it("keeps the mark when the send got no answer, so the next pickup recovers", async () => {
    const lost = new Error("socket hang up");
    const { run, deps, store } = setup({ ticket: ticket(3, "send") }, { send: vi.fn(async () => Promise.reject(lost)) });

    await expect(runMedia(run, deps)).rejects.toBe(lost);
    expect(store.sendingAt).not.toBeNull();
  });

  it("fails with the upstream's reason, the mark cleared", async () => {
    const reason = new UpstreamTaskFailed("fal", "content flagged");
    const { run, deps, store } = setup({ ticket: ticket(3, "running") }, { poll: vi.fn(async (): Promise<MediaAnswer> => ({ state: "failed", reason, costs: [COST], ...NONE })) });

    const failed = await runMedia(run, deps).catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(MediaRunFailed);
    expect((failed as MediaRunFailed).reason).toBe(reason);
    // The row and the node read an upstream's failure as they did before provider.
    expect((failed as MediaRunFailed).message).toBe("fal task failed: content flagged");
    expect((failed as MediaRunFailed).costs).toEqual([COST]);
    expect(store.sendingAt).toBeNull();
  });

  it("fails with provider's own words for any other reason", async () => {
    const reason = new Error("no upstream serves kling-o3-pro: WAVESPEED_API_KEY is not set");
    const { run, deps } = setup({ ticket: ticket(3, "running") }, { poll: vi.fn(async (): Promise<MediaAnswer> => ({ state: "failed", reason, costs: [], ...NONE })) });

    await expect(runMedia(run, deps)).rejects.toMatchObject({ message: reason.message });
  });

  it("writes back every clone an answer made or retired, and logs its warnings", async () => {
    const made = { upstream: "fal", kind: "voice" as const, sourceKey: "sha-a", upstreamId: "fv-1" };
    const gone = { upstream: "wavespeed", kind: "voice" as const, sourceKey: "sha-a", upstreamId: "v-1" };
    const { run, deps, recorded, retired } = setup({ ticket: ticket(3, "running") }, {
      poll: vi.fn(async (): Promise<MediaAnswer> => ({ ...done(["https://up/a.wav"]), clones: [made], retiredClones: [gone], warnings: [{ code: "upstream_switched", detail: { to: "fal" } }] })),
    });

    await runMedia(run, deps);

    expect(recorded).toEqual([["studio-1", "fal", "voice", "sha-a", "fv-1"]]);
    expect(retired).toEqual([["studio-1", "wavespeed", "voice", "v-1"]]);
    expect(logger.warn).toHaveBeenCalledWith({ taskId: "task-1", to: "fal" }, "upstream_switched");
  });

  it("writes no clone for a run outside a studio", async () => {
    const { run, deps, recorded } = setup({ ticket: ticket(3, "running") }, {
      poll: vi.fn(async (): Promise<MediaAnswer> => ({ ...done(["https://up/a.wav"]), clones: [{ upstream: "fal", kind: "voice", sourceKey: "sha-a", upstreamId: "x" }] })),
    });

    await runMedia({ ...run, studioId: null }, deps);

    expect(recorded).toEqual([]);
  });
});
