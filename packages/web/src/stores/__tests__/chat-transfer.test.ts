// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A chat message whose body is over the request limit (inner#1006 design
 * §4.7): the send uploads it as a transfer file and sends `{ transfer }`
 * instead (inner#1717: through `POST /chat/message`, answered with JSON).
 * Nothing watches for beats while it uploads: the heartbeat watchdog is armed
 * only while a run's stream is read, so a long upload is never told as a
 * network problem.
 *
 * The transfer's four steps (ticket, parts, finish, ending) are stubbed to
 * succeed after a stretch of fake time, and each records the signal it was
 * handed; `apiPost` also records what reaches the chat endpoint.
 *
 * Test spec: inner#1006 §7.1 W11 (chat), W13, W14 and §7.2 H01.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SharedModule from '@breatic/shared';
import type { HeldUpload } from '@breatic/shared';
import type * as RequestModule from '@web/data/api/request';
import type * as UploadStatusModule from '@web/data/upload/upload-status';

vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));
vi.mock('@breatic/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModule>()),
  sendBytesToIngest: vi.fn(),
}));
vi.mock('@web/data/upload/upload-status', async (importOriginal) => ({
  ...(await importOriginal<typeof UploadStatusModule>()),
  waitForUploadEnding: vi.fn(),
}));

import { sendBytesToIngest } from '@breatic/shared';
import { apiGet, apiPost } from '@web/data/api/request';
import { assetsApi } from '@web/data/api/assets';
import { ApiException } from '@web/data/api/types';
import type { UploadTicket } from '@web/data/upload/ingest-upload';
import { waitForUploadEnding, type UploadEnding } from '@web/data/upload/upload-status';
import { watchChatMishaps } from '@web/stores/chat-mishaps';
import type { ChatMishap } from '@web/stores/chat-mishaps';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { conversationRuntime } from '@web/stores/conversation-runtime';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';

const PROJECT = 'p-1';
const CONVERSATION = 'c-1';
const KEY = 'transfer/2026-10-24/1_00000000-0000-4000-8000-000000000002.transfer';

/** The request-body limit the server names in this file: small, so a long sentence crosses it. */
const LIMIT = 300;
/** A sentence whose request body is well over {@link LIMIT}. */
const LONG = 'x'.repeat(2000);
/** A sentence whose request body stays under it. */
const SHORT = 'hi';

const TICKET: UploadTicket = {
  uploadId: 'upload-1',
  token: 'token-1',
  storageKey: KEY,
  uploadUrl: 'https://ingest.test.invalid',
  kind: 'file',
  partSize: 1024,
  totalParts: 3,
};

/** How long each stubbed step takes, in fake milliseconds. */
interface Timing {
  config: number;
  ticket: number;
  parts: number[];
  finish: number;
  wait: number;
  /** The ticket and parts run to the end even when their signal aborts. */
  ignoreAbort: boolean;
}

const DEFAULT_TIMING: Timing = {
  config: 0,
  ticket: 1000,
  parts: [6000, 6000, 5000],
  finish: 1000,
  wait: 1000,
  ignoreAbort: false,
};

/** One message that reached the chat endpoint. */
interface Sent {
  at: number;
  body: unknown;
  /** The request options it went with. */
  config: { headers?: Record<string, string> } | undefined;
}

let timing: Timing = DEFAULT_TIMING;
let sent: Sent[] = [];
let told: ChatMishap[] = [];
let stopWatching: (() => void) | undefined;

/** What the transfer's steps saw. */
let seen: {
  ticketBodies: unknown[];
  ticketSignals: unknown[];
  partSignals: (AbortSignal | undefined)[];
  partsStarted: number;
  finishes: number;
  waits: number;
};

/**
 * Wait `ms` of fake time, ending early with an AbortError when `signal` aborts.
 * @param ms - How long.
 * @param signal - Stops the wait, unless the timing says to ignore it.
 * @returns Once the time has passed.
 */
function sleep(ms: number, signal?: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!(signal instanceof AbortSignal) || timing.ignoreAbort) return;
    const stop = (): void => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Install the transfer stubs and the config answer for this file's limit.
 */
function stubTransfer(): void {
  seen = { ticketBodies: [], ticketSignals: [], partSignals: [], partsStarted: 0, finishes: 0, waits: 0 };
  assetsApi.resetUploadConfigCache();
  vi.mocked(apiGet).mockImplementation(async (url: string) => {
    if (url !== '/assets/upload-config') throw new Error(`unexpected GET ${url}`);
    await sleep(timing.config);
    return {
      maxUploadBytes: 2 * 1024 * 1024 * 1024,
      clientMaxAttempts: 3,
      clientRetryBaseDelayMs: 1,
      uploadIdleTimeoutMs: 30_000,
      assetUrlPrefix: 'https://assets.test.invalid/',
      uploadStatusPollSeconds: 1,
      maxRequestBodyBytes: LIMIT,
    };
  });
  vi.mocked(apiPost).mockImplementation(async (url: string, body?: unknown, config?: { signal?: unknown }) => {
    if (url === '/assets/transfer-ticket') {
      seen.ticketBodies.push(body);
      seen.ticketSignals.push(config?.signal);
      await sleep(timing.ticket, config?.signal);
      return TICKET;
    }
    if (url === '/chat/message') {
      sent.push({ at: Date.now(), body, config: config as Sent['config'] });
      return { status: 'queued', pending: [], running: false };
    }
    if (/^\/assets\/uploads\/[^/]+\/complete$/.test(url)) {
      seen.finishes += 1;
      await sleep(timing.finish, config?.signal);
      return { storageKey: KEY };
    }
    throw new Error(`unexpected POST ${url}`);
  });
  vi.mocked(sendBytesToIngest).mockImplementation(async (...args: unknown[]): Promise<HeldUpload> => {
    const signal = args.find((arg): arg is AbortSignal => arg instanceof AbortSignal);
    seen.partSignals.push(signal);
    for (const ms of timing.parts) {
      if (signal?.aborted === true && !timing.ignoreAbort) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      seen.partsStarted += 1;
      await sleep(ms, signal);
    }
    return { uploadId: 'upload-1', token: 'part-token', parts: [{ partNumber: 1, etag: 'e1' }] };
  });
  vi.mocked(waitForUploadEnding).mockImplementation(async (key: string) => {
    seen.waits += 1;
    await sleep(timing.wait);
    return { key, state: 'transferred' } as UploadEnding;
  });
}

/**
 * Open the conversation's session.
 */
function openSession(): void {
  chatSessionFor({ projectId: PROJECT, conversationId: CONVERSATION, history: [], onTitled: () => undefined });
}

/**
 * Send a message to the conversation.
 * @param words - What is typed.
 * @returns How the send ended.
 */
function send(words: string): ReturnType<typeof chatLive.send> {
  return chatLive.send({ projectId: PROJECT, conversationId: CONVERSATION, words, chips: [], spaces: {} });
}

/**
 * Advance fake time in steps until `done` holds or `limitMs` is spent.
 * @param done - The condition.
 * @param limitMs - The most fake time to spend.
 * @param stepMs - The step.
 * @returns Once it holds, or the limit is reached.
 */
async function advanceUntil(done: () => boolean, limitMs: number, stepMs = 100): Promise<void> {
  for (let spent = 0; spent < limitMs && !done(); spent += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  timing = DEFAULT_TIMING;
  sent = [];
  told = [];
  stopWatching = watchChatMishaps((mishap) => told.push(mishap));
  stubTransfer();
  openSession();
});

afterEach(() => {
  stopWatching?.();
  resetChatLiveForTests();
  resetRunOnceForTests();
  evictAllChatSessions();
  assetsApi.resetUploadConfigCache();
  vi.useRealTimers();
});

describe('what a long chat message sends (W13, W14)', () => {
  it('W14 sends exactly {"transfer": key} once the upload ended transferred', async () => {
    void send(LONG);

    await advanceUntil(() => sent.length > 0, 30_000);

    expect(seen.ticketBodies).toHaveLength(1);
    expect(seen.ticketBodies[0]).toMatchObject({ project_id: PROJECT });
    const [request] = sent;
    expect(request?.body).toEqual({ transfer: KEY });
    expect(request?.config?.headers?.['Idempotency-Key']).toEqual(expect.any(String));
  });

  it('W13 sends a short message as it is, with no transfer', async () => {
    void send(SHORT);

    await advanceUntil(() => sent.length > 0, 1000);

    expect(seen.ticketBodies).toHaveLength(0);
    const [request] = sent;
    expect(request?.body).toEqual({
      id: expect.any(String),
      message: SHORT,
      project_id: PROJECT,
      conversation_id: CONVERSATION,
      attached_chips: [],
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });
});

describe('a long upload (H01)', () => {
  it('H01 a 20 s upload is not given up on: nothing is told and the message goes out when it ends', async () => {
    const startedAt = Date.now();
    let ended = false;
    void send(LONG).then(() => {
      ended = true;
    });

    await advanceUntil(() => sent.length > 0, 25_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(told).toEqual([]);
    expect(sent[0]?.at).toBe(startedAt + 20_000);
    expect(ended).toBe(true);
    expect(conversationRuntime.draftOf(CONVERSATION)).toBe('');
  });
});

describe('a failed upload is told like any failed send (W11)', () => {
  it('tells what the server said, sends nothing to the chat endpoint and keeps the words', async () => {
    conversationRuntime.setDraft(CONVERSATION, LONG);
    vi.mocked(apiPost).mockImplementation(async () => {
      throw new ApiException({ status: 400, message: 'Uploads are unavailable', fromServer: true });
    });
    void send(LONG);

    await vi.advanceTimersByTimeAsync(2000);

    expect(sent).toHaveLength(0);
    expect(told).toEqual([{ projectId: PROJECT, conversationId: CONVERSATION, kind: 'server', message: 'Uploads are unavailable' }]);
    expect(conversationRuntime.draftOf(CONVERSATION)).toBe(LONG);
  });
});
