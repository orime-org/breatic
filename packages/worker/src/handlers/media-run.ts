// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One pickup of a media run through provider's tickets (inner#1743, design §12.2).
 *
 * The run's state is the ticket provider hands back, stored on the task row before every paid request together with
 * a mark that a send is in flight. A pickup goes on from what the row holds: a ticket running upstream is asked
 * about, a send ticket whose mark is set (a send cut by a crash) is recovered, a send ticket is sent, a task left by
 * the code before provider is turned into a ticket, and a new task is planned. Each next step is sent in the same
 * pickup until the run is running upstream, which goes back to the queue, or ends. Every clone an answer made or
 * retired is written back to the studio's cache.
 */

import { logger } from "@breatic/core";
import { assertBeforeDeadline, DeadlinePassed } from "@breatic/shared";
import { DeadlinePassed as ProviderDeadlinePassed, SendNotAccepted, UpstreamTaskFailed, type Cost, type Route } from "@breatic/provider";
import { ticketState, type LegacyRows, type MediaAnswer, type MediaInput, type MediaOutput, type MediaRunner, type MediaTicket } from "@breatic/provider/media";
import type { taskRepo, upstreamCloneRepo } from "@breatic/domain";

import { StillRunning } from "@worker/handlers/still-running.js";

/** The run a task asks for. */
export interface MediaRun {
  taskId: string;
  /** The studio whose clone cache the run reads and writes; null leaves the cache alone. */
  studioId: string | null;
  model: string;
  /**
   * Our params and prompt, laid out to send (`paramsToSend`). Built only when the run is opened, from what a task
   * from before provider left behind: a step that already went out is not prepared again.
   * @param legacy - What the task left behind; empty for a new task.
   */
  input(legacy: LegacyRows): Promise<MediaInput>;
  route: Route;
  /** The task's deadline, in epoch milliseconds. */
  deadlineAt: number;
  /** How many outputs the task writes: 1 for a canvas generation, the tool's outputs for a mini-tool. */
  outputCount: number;
}

/** What the run reads and writes besides provider. */
export interface MediaRunDeps {
  runner: MediaRunner;
  tickets: Pick<typeof taskRepo, "getProviderTicket" | "storeTicket" | "markSending" | "clearSending">;
  clones: Pick<typeof upstreamCloneRepo, "liveClonesFor" | "recordClone" | "retireClone">;
  /**
   * The sha256 of the asset behind one of our storage urls, or null for a url that is not ours.
   * @param url - A source url.
   */
  sourceKeyOf(url: string): Promise<string | null>;
  /**
   * What a task from before the provider layer left behind.
   * @param taskId - The task.
   */
  legacy(taskId: string): Promise<LegacyRows>;
  /**
   * Run a description inside one of this process's reading places; throws `StillRunning` when none is free.
   * @param work - The send.
   */
  readingPlace<T>(work: () => Promise<T>): Promise<T>;
  /** How long a run that cannot store its ticket waits before its next pickup. */
  pollIntervalMs: number;
}

/** A run that finished. */
export interface MediaRunDone {
  /** What it made, up to the outputs the task writes. */
  outputs: MediaOutput[];
  /** What each billed answer of the run cost. */
  costs: Cost[];
  /** The upstream that served it. */
  servedBy: string;
}

/**
 * A run provider answered failed: an upstream refused or failed it, or no upstream can take it. Its message is what
 * the task row and the node show: an upstream's failure reads as it did before provider, its own words after the
 * upstream's name.
 */
export class MediaRunFailed extends Error {
  /**
   * Record why, and what the run cost before it failed.
   * @param reason - provider's reason.
   * @param costs - What the billed answers cost.
   */
  constructor(
    readonly reason: Error,
    readonly costs: Cost[],
  ) {
    super(reason instanceof UpstreamTaskFailed ? `${reason.upstream} task failed: ${reason.upstreamError}` : reason.message, { cause: reason });
    this.name = "MediaRunFailed";
  }
}

/**
 * Every url a run's params carry, for the clone cache's keys.
 * @param params - The run's params.
 * @returns The urls, each once.
 */
function sourceUrls(params: Readonly<Record<string, unknown>>): string[] {
  const urls = new Set<string>();
  for (const value of Object.values(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string" && /^https?:\/\//.test(item)) urls.add(item);
    }
  }
  return [...urls];
}

/**
 * The first answer of a task with no ticket: a ticket from what an older task left, or a fresh plan.
 * @param run - The run.
 * @param deps - Its dependencies.
 * @returns provider's answer.
 */
async function open(run: MediaRun, deps: MediaRunDeps): Promise<MediaAnswer> {
  const legacy = await deps.legacy(run.taskId);
  const input = await run.input(legacy);
  const sourceKeys: Record<string, string> = {};
  for (const url of sourceUrls(input.params)) {
    const sha = await deps.sourceKeyOf(url);
    if (sha !== null) sourceKeys[url] = sha;
  }
  const shas = [...new Set(Object.values(sourceKeys))];
  const clones = run.studioId === null ? [] : await deps.clones.liveClonesFor(run.studioId, shas);
  const options = { idempotencyKey: run.taskId, sourceKeys, clones, durations: {} };
  const left = (legacy.providerTaskId ?? null) !== null || (legacy.steps ?? []).length > 0;
  return left
    ? deps.runner.ticketFromLegacy(run.model, input, run.route, options, legacy)
    : deps.runner.plan(run.model, input, run.route, options);
}

/**
 * The first answer of this pickup, from what the task holds.
 * @param run - The run.
 * @param deps - Its dependencies.
 * @param held - What the task holds.
 * @returns The answer to go on from.
 */
async function resume(run: MediaRun, deps: MediaRunDeps, held: taskRepo.StoredTicket): Promise<MediaAnswer> {
  if (held.ticket === null) return open(run, deps);
  const ticket = held.ticket as MediaTicket;
  const state = ticketState(ticket);
  if (state.phase === "running") return deps.runner.poll(ticket, { deadlineAt: run.deadlineAt, finalAsk: Date.now() >= run.deadlineAt });
  if (held.sendingAt !== null) return deps.runner.recover(ticket, { deadlineAt: run.deadlineAt });
  return { state: "send", ticket, step: { kind: state.step }, clones: [], retiredClones: [], warnings: [] };
}

/**
 * Write back what an answer made or retired, and log what provider asked to be logged.
 * @param run - The run.
 * @param deps - Its dependencies.
 * @param answer - The answer.
 */
async function absorb(run: MediaRun, deps: MediaRunDeps, answer: MediaAnswer): Promise<void> {
  for (const warning of answer.warnings) logger.warn({ taskId: run.taskId, ...warning.detail }, warning.code);
  if (run.studioId === null) return;
  for (const clone of answer.clones) await deps.clones.recordClone(run.studioId, clone.upstream, clone.kind, clone.sourceKey, clone.upstreamId);
  for (const clone of answer.retiredClones) await deps.clones.retireClone(run.studioId, clone.upstream, clone.kind, clone.upstreamId);
}

/**
 * Store a ticket over the one the task holds; a run that finds a newer one stored stops and comes back.
 * @param run - The run.
 * @param deps - Its dependencies.
 * @param ticket - The ticket.
 * @param stored - The version the task holds already, when the ticket is that one.
 * @throws {StillRunning} When another run stored a newer ticket.
 */
async function store(run: MediaRun, deps: MediaRunDeps, ticket: MediaTicket, stored: number | undefined): Promise<void> {
  if (stored === ticket.version) return;
  if (!(await deps.tickets.storeTicket(run.taskId, ticket))) {
    logger.warn({ taskId: run.taskId, version: ticket.version }, "media_ticket_superseded");
    throw new StillRunning(Date.now() + deps.pollIntervalMs);
  }
}

/**
 * Send a stored ticket's next step with the sending mark set.
 * @param run - The run.
 * @param deps - Its dependencies.
 * @param ticket - The ticket, stored.
 * @returns provider's answer.
 */
async function sendOnce(run: MediaRun, deps: MediaRunDeps, ticket: MediaTicket): Promise<MediaAnswer> {
  await deps.tickets.markSending(run.taskId);
  return deps.runner.send(ticket, { deadlineAt: run.deadlineAt });
}

/**
 * Run one pickup of a media run.
 * @param run - The run.
 * @param deps - Its dependencies.
 * @returns What the run made, its costs and the upstream that served it.
 * @throws {StillRunning} When the run is running upstream, or no reading place is free for its description.
 * @throws {MediaRunFailed} When provider answered the run failed.
 * @throws {DeadlinePassed} When the deadline passed before a step could be sent, or cut a call.
 * @throws {SendNotAccepted} When the upstream did not take a step; the queue retries it.
 */
export async function runMedia(run: MediaRun, deps: MediaRunDeps): Promise<MediaRunDone> {
  try {
    const held = await deps.tickets.getProviderTicket(run.taskId);
    let storedVersion = held.ticket?.version;
    // Whether a send's mark is on the row, so it is cleared only where one was written.
    let marked = held.sendingAt !== null;
    /**
     * Clear the sending mark when one is on the row.
     */
    const unmark = async (): Promise<void> => {
      if (!marked) return;
      await deps.tickets.clearSending(run.taskId);
      marked = false;
    };
    let answer = await resume(run, deps, held);
    for (;;) {
      await absorb(run, deps, answer);
      switch (answer.state) {
        case "done":
          // The mark of a send that finished the run stays until the caller records the result (design §12.2).
          return { outputs: answer.outputs.slice(0, run.outputCount), costs: answer.costs, servedBy: answer.servedBy };
        case "failed":
          await unmark();
          throw new MediaRunFailed(answer.reason, answer.costs);
        case "running":
          await store(run, deps, answer.ticket, storedVersion);
          await unmark();
          throw new StillRunning(answer.askAgainAt);
        case "send": {
          await store(run, deps, answer.ticket, storedVersion);
          storedVersion = answer.ticket.version;
          await unmark();
          // Nothing new goes out past the deadline; a step already sent is still asked about.
          assertBeforeDeadline(run.deadlineAt);
          const ticket = answer.ticket;
          /**
           * Send the ticket, the mark written first.
           * @returns provider's answer.
           */
          const sent = async (): Promise<MediaAnswer> => {
            marked = true;
            return sendOnce(run, deps, ticket);
          };
          answer = answer.step.kind === "describe" ? await deps.readingPlace(sent) : await sent();
          break;
        }
      }
    }
  } catch (error) {
    // A step the upstream did not take is retried as the same ticket by the queue, unmarked; a send that went
    // unanswered keeps its mark, so the next pickup recovers it.
    if (error instanceof SendNotAccepted) await deps.tickets.clearSending(run.taskId);
    // provider's deadline is the task's: the run ends the way every call on the task's chain ends there.
    if (error instanceof ProviderDeadlinePassed) throw new DeadlinePassed();
    throw error;
  }
}
