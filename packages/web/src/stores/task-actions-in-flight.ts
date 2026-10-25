// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Presses still waiting for their answer, kept outside the panel that started
 * them so closing and reopening it finds the button still waiting.
 *
 * Two kinds live here. The task-row requests (inner#1374) are keyed like the
 * retry stash (`spaces/canvas/upload-retry-files.ts`) — project, space, task —
 * plus the request pressed, so one row's Retry and Clear each wait on their
 * own. The run-once presses (inner#1490) — generate, understand, a mini-tool
 * run, a new conversation, membership checkout or change, a new project, a
 * credits checkout — carry one `Idempotency-Key` each, are re-sent with that
 * key and the body fixed at the press until the server answers for good, and
 * are let go when the page leaves, the account changes, or the server would
 * no longer remember them.
 */

import { create } from 'zustand';
import {
  exponentialJitterDelay,
  idempotencyRetryDeadline,
  newId,
  t,
  type IdempotencyScope,
} from '@breatic/shared';

import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';
import { useCurrentUserStore } from '@web/stores/current-user';

/**
 * The two requests a task row sends. Finish and Clear are the same dismiss
 * request (§7.4); View sends nothing.
 */
export type TaskActionRequest = 'retry' | 'dismiss';

/** The requests waiting, and the two ways a press enters and leaves. */
interface TaskActionsInFlightState {
  /** {@link taskActionKey} of every request waiting on the server. */
  inFlight: ReadonlySet<string>;
  /** Mark a request as waiting. */
  start: (key: string) => void;
  /** Mark a request as answered. */
  end: (key: string) => void;
  /** Each run-once press waiting, by intent, with what its button shows. */
  running: ReadonlyMap<string, unknown>;
}

export const useTaskActionsInFlight = create<TaskActionsInFlightState>()((set) => ({
  inFlight: new Set(),
  start: (key) => set((s) => ({ inFlight: new Set(s.inFlight).add(key) })),
  end: (key) =>
    set((s) => {
      const next = new Set(s.inFlight);
      next.delete(key);
      return { inFlight: next };
    }),
  running: new Map(),
}));

/**
 * The store key for one request on one task row.
 * @param projectId - Owning project.
 * @param spaceId - Space the task's node lives in.
 * @param taskId - The task.
 * @param request - Which of the row's requests was pressed.
 * @returns The key.
 */
export function taskActionKey(
  projectId: string,
  spaceId: string,
  taskId: string,
  request: TaskActionRequest,
): string {
  return `${projectId}/${spaceId}/${taskId}/${request}`;
}

/** The existing run-once actions that belong to a Space. */
export type SpaceTaskAction = 'generate' | 'understand' | 'transcribe' | 'mini-tool';
const SPACE_TASK_ACTIONS: readonly SpaceTaskAction[] = ['generate', 'understand', 'transcribe', 'mini-tool'];

/**
 * Build the existing Space intent shared by buttons and status readers.
 * @param action - Existing run-once action.
 * @param spaceId - Owning Space.
 * @param nodeId - Target node, or empty for a Space prefix.
 * @param toolId - Mini-tool identity when present.
 * @returns The existing intent key.
 * @throws {never} Never.
 */
export function spaceTaskIntent(action: SpaceTaskAction, spaceId: string, nodeId: string, toolId?: string): string {
  return `${action}:${spaceId}:${nodeId}${toolId === undefined ? '' : `:${toolId}`}`;
}

/**
 * Read existing Space requests and Retry waits without changing their lifetimes.
 * @param state - Existing request store snapshot.
 * @param projectId - Owning Project.
 * @param spaceId - Observed Space.
 * @returns Whether a request or Retry is pending.
 * @throws {never} Never.
 */
export function hasSpaceTaskRequests(
  state: Pick<TaskActionsInFlightState, 'running' | 'inFlight'>,
  projectId: string,
  spaceId: string,
): boolean {
  const pending = [...state.running.keys()].some((intent) =>
    SPACE_TASK_ACTIONS.some((action) => intent.startsWith(spaceTaskIntent(action, spaceId, ''))));
  const rowPrefix = `${projectId}/${spaceId}/`;
  return pending || [...state.inFlight].some((key) => key.startsWith(rowPrefix) && key.endsWith('/retry'));
}

/**
 * Hold a request as waiting until the work behind its press settles, either
 * way.
 * @param key - The request's {@link taskActionKey}.
 * @param work - The press's work.
 */
export function trackTaskAction(key: string, work: Promise<unknown>): void {
  const { start, end } = useTaskActionsInFlight.getState();
  start(key);
  void work.then(
    () => end(key),
    () => end(key),
  );
}

/** What one run-once press does, given by the button that starts it. */
export interface RunOnceSpec<B, R> {
  /** Which run-once request it sends; sets how long the server remembers it. */
  scope: IdempotencyScope;
  /** What {@link useRunning} answers while it waits; `true` when omitted. */
  meta?: unknown;
  /**
   * Runs once at the press: builds the request body and whatever the press
   * creates before sending (a result node). Null ends the press without a
   * request.
   */
  prepare: () => B | null | Promise<B | null>;
  /** Sends the request; the only part that is re-sent. */
  send: (key: string, body: B) => Promise<R>;
  /** The final success; `leaving` keeps the button waiting while the page navigates away. */
  onDone?: (result: R) => 'leaving' | undefined;
  /** The final failure, for the press to tell the reader. */
  onFailure?: (err: unknown) => void;
}

/**
 * How a press ended: the server's final success, its final failure, or let go
 * without an answer to act on (nothing to send, the account changed, the page
 * came back, the server would no longer remember it).
 */
export type RunOnceOutcome<R> =
  | { kind: 'done'; result: R }
  | { kind: 'failed'; error: unknown }
  | { kind: 'released' };

/** One press in flight. */
interface Press {
  /** `leaving` survives until the page leaves or comes back from the cache. */
  phase: 'working' | 'leaving';
  /** Clears the pending re-send, when one is scheduled. */
  cancel: (() => void) | null;
  /** The press's whole run, handed to a second press of the same intent. */
  promise: Promise<RunOnceOutcome<unknown>>;
}

/** The outcome of a press let go without an answer to act on. */
const RELEASED: RunOnceOutcome<never> = { kind: 'released' };

/** Each press waiting, by intent. */
const presses = new Map<string, Press>();

/**
 * Ceiling of one backoff wait between re-sends (inner#1490 §6.2); a wait the
 * server names with Retry-After is taken as given.
 */
const MAX_RESEND_WAIT_MS = 30_000;

/**
 * Ceiling of the first jittered wait between re-sends; it doubles per re-send,
 * up to MAX_RESEND_WAIT_MS.
 */
const RESEND_BASE_MS = 1_000;

/**
 * Show or clear a press on the button that reads it.
 * @param intentId - The press's intent.
 * @param meta - What the button shows, or undefined to clear it.
 */
function publish(intentId: string, meta: unknown): void {
  useTaskActionsInFlight.setState((s) => {
    const next = new Map(s.running);
    if (meta === undefined) next.delete(intentId);
    else next.set(intentId, meta);
    return { running: next };
  });
}

/**
 * Let a press go: its button stops waiting and a scheduled re-send is dropped.
 * @param intentId - The press's intent.
 * @param press - The press, so a newer press of the same intent is left alone.
 */
function release(intentId: string, press: Press): void {
  if (presses.get(intentId) !== press) return;
  presses.delete(intentId);
  press.cancel?.();
  publish(intentId, undefined);
  if (![...presses.values()].some((p) => p.phase === 'leaving')) stopWatchingRestore();
}

/**
 * A page restored from the back-forward cache comes back with the presses
 * that were navigating away; that navigation is over.
 * @param event - The `pageshow` event; `persisted` is true only on a restore.
 */
function onPageShow(event: PageTransitionEvent): void {
  if (!event.persisted) return;
  for (const [intentId, press] of [...presses]) {
    if (press.phase === 'leaving') release(intentId, press);
  }
}

/** Whether {@link onPageShow} is attached. */
let watchingRestore = false;

/**
 * Listen for a back-forward-cache restore while a press is leaving the page.
 */
function watchRestore(): void {
  if (watchingRestore || typeof window === 'undefined') return;
  window.addEventListener('pageshow', onPageShow);
  watchingRestore = true;
}

/**
 * Stop listening once no press is leaving.
 */
function stopWatchingRestore(): void {
  if (!watchingRestore) return;
  window.removeEventListener('pageshow', onPageShow);
  watchingRestore = false;
}

/**
 * Let every press go.
 */
function releaseAll(): void {
  for (const [intentId, press] of [...presses]) release(intentId, press);
}

/**
 * How long to wait before asking again, or null when the answer is final.
 *
 * The server's `Idempotency-Status: done` is final either way. Without it, no
 * answer, a press still running, a throttle and any 5xx (a proxy timing out
 * included) leave the outcome unknown; anything else was refused before it ran.
 * @param err - What the send rejected with.
 * @param attempt - Re-sends so far.
 * @returns Milliseconds to wait, or null.
 */
function resendWait(err: unknown, attempt: number): number | null {
  if (!(err instanceof ApiException) || err.idempotencyStatus === 'done') return null;
  const unknown =
    err.idempotencyStatus === 'in_progress' ||
    err.network ||
    err.status === 429 ||
    err.status >= 500;
  if (!unknown) return null;
  if (err.retryAfterSeconds !== undefined) return err.retryAfterSeconds * 1000;
  return Math.min(MAX_RESEND_WAIT_MS, exponentialJitterDelay(Math.min(attempt, 5), RESEND_BASE_MS));
}

/**
 * Wait, unless the press is let go first.
 * @param press - The press.
 * @param ms - How long.
 * @returns Whether the wait ran out (false when the press was let go).
 */
function wait(press: Press, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      press.cancel = null;
      resolve(true);
    }, ms);
    press.cancel = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
  });
}

/**
 * Run one press from preparing to its final answer.
 * @param intentId - The press's intent.
 * @param press - The press.
 * @param spec - What the press does.
 * @returns How the press ended.
 */
async function drive<B, R>(
  intentId: string,
  press: Press,
  spec: RunOnceSpec<B, R>,
): Promise<RunOnceOutcome<R>> {
  /**
   * Whether this press is still the one registered for its intent.
   * @returns False once it was let go.
   */
  const current = (): boolean => presses.get(intentId) === press;
  let body: B | null;
  try {
    body = await spec.prepare();
  } catch (err) {
    if (!current()) return RELEASED;
    release(intentId, press);
    spec.onFailure?.(err);
    return { kind: 'failed', error: err };
  }
  if (!current()) return RELEASED;
  if (body === null) {
    release(intentId, press);
    return RELEASED;
  }
  const key = newId();
  const stopAt = idempotencyRetryDeadline(spec.scope, Date.now());
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await spec.send(key, body);
      if (!current()) return RELEASED;
      if (spec.onDone?.(result) === 'leaving') {
        press.phase = 'leaving';
        watchRestore();
      } else {
        release(intentId, press);
      }
      return { kind: 'done', result };
    } catch (err) {
      if (!current()) return RELEASED;
      const ms = resendWait(err, attempt);
      if (ms === null) {
        release(intentId, press);
        spec.onFailure?.(err);
        return { kind: 'failed', error: err };
      }
      if (!(await wait(press, ms)) || !current()) return RELEASED;
      // Wall clock, checked as the re-send goes out: a laptop asleep in
      // between fires this timer on waking, and the server may have
      // forgotten the press by then.
      if (Date.now() >= stopAt) {
        release(intentId, press);
        toast.error(t('common.runOnce.unknownResult'));
        return RELEASED;
      }
    }
  }
}

/**
 * Press a run-once button: prepare once, send with one key, and keep asking
 * with that key and body until the server answers for good.
 *
 * A press while one of the same intent waits does nothing and joins it.
 * @param intentId - Which press this is (`generate:{spaceId}:{nodeId}`, …).
 * @param spec - What the press does.
 * @returns How the press ended; a joining press gets the waiting one's.
 */
export function runOnce<B, R>(
  intentId: string,
  spec: RunOnceSpec<B, R>,
): Promise<RunOnceOutcome<R>> {
  const waiting = presses.get(intentId);
  // One intent id names one request, so the waiting press answers with the
  // same `R` as this one.
  if (waiting) return waiting.promise as Promise<RunOnceOutcome<R>>;
  const press: Press = { phase: 'working', cancel: null, promise: Promise.resolve(RELEASED) };
  presses.set(intentId, press);
  publish(intentId, spec.meta ?? true);
  const run = drive(intentId, press, spec);
  press.promise = run;
  return run;
}

/**
 * What a waiting press shows, outside React.
 * @param intentId - The press's intent.
 * @returns Its meta (or `true`) while it waits; undefined when idle.
 */
export function getRunning(intentId: string): unknown {
  return useTaskActionsInFlight.getState().running.get(intentId);
}

/**
 * What a waiting press shows; the button's `loading` reads it.
 * @param intentId - The press's intent.
 * @returns Its meta (or `true`) while it waits; undefined when idle.
 */
export function useRunning(intentId: string): unknown {
  return useTaskActionsInFlight((s) => s.running.get(intentId));
}

/**
 * Let every press go between test cases.
 */
export function resetRunOnceForTests(): void {
  releaseAll();
}

// A press made for the previous account must not be re-sent as the next one.
useCurrentUserStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) releaseAll();
});
