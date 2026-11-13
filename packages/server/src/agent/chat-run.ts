// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One run of the Agent in one conversation, started by whichever entrance
 * won the conversation, and run to its end on the server whoever is reading
 * (inner#1717).
 *
 * A run has two stages. The opening stage checks the conversation's owner may
 * still run it, takes what waits (first what a dead run left taken, minus what
 * a stored reply already answered), writes the opening message's row under its
 * id, holds the run's place in the running list and creates the run's
 * resumable stream. The request that started the run answers only once that
 * is done, so the page it answers finds the opening in the history and the
 * stream to attach to. The running stage is the turn itself, in the
 * background. The whole run is after-reply work, from its first line, so a
 * shutdown waits for it before closing the pools it needs.
 */
import { env, ForbiddenError, getAgentConfig, logger, NotFoundError, runWithContext, runWithLocale } from "@breatic/core";
import { SMALLEST_CREDIT } from "@breatic/domain";
import type { ChatSpaceContext } from "@breatic/shared";
import type { UIMessageChunk } from "ai";
import { conversationService, precheckCredits, projectService, runningTurnsService } from "@server/modules";
import { chatQueue, type RunEnding } from "@server/modules/chat-queue/chat-queue.service.js";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";
import { runAfterReply } from "@server/utils/after-reply.js";
import { MainAgent } from "@server/agent/main-agent.js";
import { runWire } from "@server/agent/run-wire.js";
import { chatSubscriber, runStreams } from "@server/agent/run-stream.js";
import { isShuttingDown, trackRun } from "@server/agent/shutdown-flag.js";
import { takenMessageOf, type TakenMessage, type TurnEnded } from "@server/agent/taken-message.js";

/** How a run was opened. */
export type RunEntrance =
  /** Opened by a send, a sync or the end of the run before: it opens with what waits. */
  | { kind: "head" }
  /** Opened by the user's answer to the card the turn stopped at, already taken. */
  | {
      kind: "card";
      toolCallId: string;
      output: unknown;
      turnIndex: number;
      timeZone?: string;
      space: ChatSpaceContext;
      modelId?: string;
      locale: string;
    };

/** Which run to start, and where. */
export interface RunStart {
  conversationId: string;
  projectId: string;
  /** The conversation's owner, who sent every message it holds. */
  userId: string;
  /** The run id the queue just wrote into the conversation's `active`. */
  runId: string;
  entrance: RunEntrance;
}

/**
 * Called once a run's stream exists and before its turn runs, and awaited.
 * Nothing in the server watches; a test attaches to the run here, so it reads
 * every frame however fast the run is.
 */
export const runObservers: Array<(run: { conversationId: string; runId: string }) => Promise<void>> = [];

/**
 * The channel a run's stop is published on.
 * @param runId - The run.
 * @returns The channel.
 */
export function stopChannel(runId: string): string {
  return `${env.REDIS_KEY_PREFIX}:chat:stop:${runId}`;
}

/**
 * Where the run's own end lands in the queue.
 * @param ended - How the turn ended, or undefined when it never got that far.
 * @returns The ending.
 */
function endingOf(ended: TurnEnded | undefined): RunEnding {
  if (ended === undefined || !ended.stored) return { kind: "unsaved" };
  if (ended.shutdown === true) return { kind: "shutdown" };
  if (ended.exit === "blocked" && ended.awaitingCall !== undefined) return { kind: "awaiting", toolCallId: ended.awaitingCall };
  return { kind: "done" };
}

/**
 * A turn that says nothing and ends: a run stopped before its running stage.
 * @returns The turn's chunks: none.
 */
const SILENT = (): Promise<ReadableStream<UIMessageChunk>> =>
  Promise.resolve(new ReadableStream<UIMessageChunk>({ start: (c) => c.close() }));

/** Thrown inside the opening stage to end the run there. */
class RunNotOpened extends Error {}

/**
 * Start a run: its opening stage, then its running stage in the background.
 * @param start - Which run, where.
 * @returns Resolves once the opening stage is done: whether the run is running.
 */
export function startRun(start: RunStart): { opened: Promise<{ running: boolean }> } {
  let tell!: (value: { running: boolean }) => void;
  const opened = new Promise<{ running: boolean }>((resolve) => {
    tell = resolve;
  });
  let told = false;
  /**
   * Say how the opening went, once.
   * @param running - Whether the run is running.
   */
  const open = (running: boolean): void => {
    if (told) return;
    told = true;
    tell({ running });
  };
  const ctx = { userId: start.userId, conversationId: start.conversationId, projectId: start.projectId };
  runAfterReply({ ...ctx, runId: start.runId, task: "chat_run" }, () =>
    runWithContext(ctx, () => runIt(start, open)).finally(() => open(false)),
  );
  return { opened };
}

/**
 * The whole run.
 * @param start - Which run, where.
 * @param open - Says how the opening went.
 */
async function runIt(start: RunStart, open: (running: boolean) => void): Promise<void> {
  const { conversationId, projectId, userId, runId, entrance } = start;
  const queue = chatQueue();
  const ctx = { userId, conversationId, projectId };

  if (isShuttingDown()) {
    if (entrance.kind === "card") await storeShutdownEnding(conversationId, entrance.turnIndex);
    await queue.settle(conversationId, runId, { kind: "shutdown" });
    return;
  }

  let conversation: Awaited<ReturnType<typeof conversationService.assertWritable>>;
  try {
    conversation = await conversationService.assertWritable(conversationId, userId, projectId);
    await projectService.assertAccess(projectId, userId, "editor");
  } catch (err) {
    // Gone, or no longer the owner's to run: what waits can never run. Any
    // other failure says nothing about that, so what waits stays for a sync.
    if (err instanceof NotFoundError || err instanceof ForbiddenError) {
      logger.warn({ err, ...ctx, runId }, "chat_run_refused");
      await queue.clear(conversationId);
    } else {
      logger.error({ err, ...ctx, runId }, "chat_run_check_failed");
      await queue.settle(conversationId, runId, { kind: "unsaved" });
    }
    return;
  }
  try {
    await precheckCredits(projectId, userId, SMALLEST_CREDIT);
  } catch (err) {
    logger.warn({ err, ...ctx, runId }, "chat_run_no_credits");
    await queue.settle(conversationId, runId, { kind: "unsaved" });
    return;
  }

  // What the turn opens with, for a run that takes it from the queue.
  let opening: TakenMessage | undefined;
  let alsoTaken: TakenMessage[] = [];
  let operationKey: string | undefined;
  if (entrance.kind === "head") {
    let taken = await queue.head(conversationId, runId);
    if (taken.length > 0) {
      const status = await messageRepo.takenStatus(conversationId, taken.map((t) => t.id));
      if (status.answered.size > 0) taken = await queue.forget(conversationId, runId, [...status.answered]);
      if (taken.length === 0) taken = await queue.head(conversationId, runId);
      const first = taken[0];
      if (first !== undefined) {
        const reused = status.unansweredRows.get(first.id);
        // A row a dead run wrote and never answered: this run answers it,
        // charged under a key of its own, since the dead run may have been
        // charged under the turn's (inner#1717).
        if (reused !== undefined) operationKey = `turn:${conversationId}:${String(reused)}:run:${runId}`;
      }
    }
    if (taken.length === 0) {
      await queue.ack(conversationId, runId, []);
      // A message sent since the head was read is handed to the next run.
      const next = await queue.settle(conversationId, runId, { kind: "done" });
      if (next !== null) startRun({ ...start, runId: next, entrance: { kind: "head" } });
      return;
    }
    opening = takenMessageOf(taken[0]!);
    alsoTaken = taken.slice(1).map(takenMessageOf);
  }

  const stop = new AbortController();
  const untrack = trackRun(stop);
  let ended: TurnEnded | undefined;
  const held: { lease: runningTurnsService.RunningLease | null } = { lease: null };
  const renew = setInterval(() => {
    void queue.renew(conversationId, runId).catch((err: unknown) => logger.error({ err, ...ctx, runId }, "chat_run_renew_failed"));
    void held.lease?.renew().catch((err: unknown) => logger.error({ err, ...ctx, runId }, "chat_running_lease_failed"));
  }, getAgentConfig().chat_run_renew_ms);
  let turnReady!: (turn: Promise<ReadableStream<UIMessageChunk>>) => void;
  const turn = new Promise<ReadableStream<UIMessageChunk>>((resolve) => {
    turnReady = resolve;
  });
  let streamOpened = false;
  let wireDone!: () => void;
  const wireEnded = new Promise<void>((resolve) => {
    wireDone = resolve;
  });

  try {
    await chatSubscriber().listen(stopChannel(runId), () => stop.abort());
    /**
     * The rest of the opening stage, once the opening row is written: the
     * run's place in the running list and its stream. Then the shutdown flag
     * is read once more, before the turn runs.
     * @throws {RunNotOpened} When the server began shutting down meanwhile.
     */
    const beforeStream = async (): Promise<void> => {
      try {
        held.lease = await runningTurnsService.holdRunning({ ...ctx, runId });
      } catch (err) {
        logger.error({ err, ...ctx, runId }, "chat_running_lease_failed");
      }
      const produced = await runStreams().createNewResumableStream(runId, () =>
        runWire({
          runId,
          ctx,
          turn: () => turn,
          afterTurn: async () => {
            try {
              return await afterTurn(start, ended);
            } finally {
              wireDone();
            }
          },
        }),
      );
      // Nobody reads the producer's own copy; pages read through attach.
      void produced?.cancel().catch(() => {});
      streamOpened = true;
      open(true);
      // All at once: each observer is called before the send it watches can answer.
      await Promise.all(runObservers.map((observe) => observe({ conversationId, runId })));
      if (isShuttingDown()) throw new RunNotOpened();
    };
    const agent = new MainAgent();
    const hooks = {
      drain: async () => (await queue.drain(conversationId, runId)).map(takenMessageOf),
      beforeStream,
      onEnded: (e: TurnEnded) => {
        ended = e;
      },
      ...(operationKey === undefined ? {} : { operationKey }),
    };
    const started =
      entrance.kind === "card"
        ? runWithLocale(entrance.locale, () =>
          agent.answer(entrance.toolCallId, entrance.output, entrance.turnIndex, stop.signal, entrance.timeZone, entrance.space, entrance.modelId, hooks),
        )
        : runWithLocale(opening!.locale ?? "en", async () =>
          agent.chat(
            opening!.message,
            stop.signal,
            opening!.chips,
            opening!.timeZone,
            opening!.space,
            await conversationService.modelForQueued(conversation, userId, opening!.model),
            { ...hooks, messageId: opening!.id, alsoTaken },
          ),
        );
    // A shutdown read before the running stage ends the run here. A card's
    // answer is in the store, so its turn ends failed for the shutdown; a
    // message's opening has no reply yet, so it stays taken, unacked, for
    // the next process to answer.
    const running = started.catch(async (err: unknown) => {
      if (!(err instanceof RunNotOpened)) throw err;
      if (entrance.kind !== "card") return SILENT();
      await storeShutdownEnding(conversationId, entrance.turnIndex);
      ended = { exit: "failed", stored: true, recorded: [], shutdown: true };
      return shutdownFrames();
    });
    turnReady(running);
    await running;
    await wireEnded;
  } catch (err) {
    if (!streamOpened) {
      logger.error({ err, ...ctx, runId }, "chat_run_open_failed");
      turnReady(SILENT());
      await queue.settle(conversationId, runId, { kind: "unsaved" });
    } else {
      await wireEnded;
    }
  } finally {
    clearInterval(renew);
    untrack();
    await chatSubscriber().unsubscribe(stopChannel(runId));
    await held.lease?.release().catch((err: unknown) => logger.error({ err, ...ctx, runId }, "chat_running_lease_failed"));
  }
}

/**
 * Settle a run after its turn ended, and open the next one when work waits.
 * @param start - The run.
 * @param ended - How the turn ended.
 * @returns The next run's id once its opening stage is done, or null.
 */
async function afterTurn(start: RunStart, ended: TurnEnded | undefined): Promise<string | null> {
  const queue = chatQueue();
  const ending = endingOf(ended);
  if (ending.kind !== "unsaved") await queue.ack(start.conversationId, start.runId, ended?.recorded ?? []);
  const next = await queue.settle(start.conversationId, start.runId, ending);
  if (next === null) return null;
  const { opened } = startRun({ ...start, runId: next, entrance: { kind: "head" } });
  return (await opened).running ? next : null;
}

/**
 * The frames a card's run says when a shutdown stopped it before it ran.
 * @returns The turn's chunks.
 */
function shutdownFrames(): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "data-failed", data: { reason: "shutdown" } });
      controller.enqueue({ type: "error", errorText: "The assistant could not finish this turn." });
      controller.close();
    },
  });
}

/**
 * Store the failed ending of a card's run a shutdown stopped before it ran:
 * the answer is in the store already, so the user sees the turn failed and
 * can go on with a message.
 * @param conversationId - The conversation.
 * @param turnIndex - The turn the card belongs to.
 */
async function storeShutdownEnding(conversationId: string, turnIndex: number): Promise<void> {
  await messageRepo.addMessage(conversationId, { role: "assistant", turnIndex, parts: [{ type: "failed", reason: "shutdown" }] });
}
