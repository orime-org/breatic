// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A chat turn whose body is over the request limit (inner#1006 design §4.7):
 * `prepareSendMessagesRequest` uploads it as a transfer file and sends
 * `{ transfer }` instead. The heartbeat watchdog waits on SSE beats, and no
 * beat can come before the request is sent, so the wait is paused while the
 * upload runs and restarted from the moment the request goes out. Stopping
 * the turn, evicting the session or leaving the project stops the upload.
 *
 * Fixture as in `heartbeat-watchdog.test.ts`: fake timers, `chatApi.streamConfig`
 * mocked, a fake `fetch` answering with an SSE stream the test pushes into,
 * and `watchChatMishaps` collecting what the reader is told. The transfer's
 * four steps (ticket, parts, finish, ending) are stubbed to succeed after a
 * stretch of fake time, and each records the signal it was handed.
 *
 * Test spec: inner#1006 §7.1
 * W11 (chat), W13, W14 and §7.2 H01-H08.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSE_HEARTBEAT_MISSES_ALLOWED, getLocale } from '@breatic/shared';
import type * as SharedModule from '@breatic/shared';
import type { HeldUpload } from '@breatic/shared';
import type * as ChatApiModule from '@web/data/api/chat';
import type * as RequestModule from '@web/data/api/request';
import type * as UploadStatusModule from '@web/data/upload/upload-status';

const BEAT_MS = 5000;
const BUDGET = BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED;

vi.mock('@web/data/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatApiModule>()),
  chatApi: {
    streamConfig: vi.fn(async () => ({ heartbeatIntervalMs: BEAT_MS, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000, spaceListMaxItems: 200 })),
  },
}));
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
import { chatApi } from '@web/data/api/chat';
import { apiGet, apiPost } from '@web/data/api/request';
import { assetsApi } from '@web/data/api/assets';
import type { UploadTicket } from '@web/data/upload/ingest-upload';
import { waitForUploadEnding, type UploadEnding } from '@web/data/upload/upload-status';
import { watchChatMishaps } from '@web/stores/chat-mishaps';
import type { ChatMishap } from '@web/stores/chat-mishaps';
import {
  chatSessionFor,
  evictAllChatSessions,
  evictChatSession,
  hasChatSession,
  sendInSession,
  stopChatSession,
} from '@web/stores/chat-sessions';
import { conversationRuntime, useConversationRuntime } from '@web/stores/conversation-runtime';

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
  ticket: 'signed-ticket',
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

/** One request made through the fake fetch. */
interface Sent {
  url: string;
  at: number;
  body: unknown;
  headers: Headers;
  signal: AbortSignal | null | undefined;
  push: (chunk: Record<string, unknown>) => void;
  close: () => void;
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
 * @returns Nothing.
 */
function openSession(): void {
  chatSessionFor({
    projectId: PROJECT,
    conversationId: CONVERSATION,
    history: [],
    onTitled: () => undefined,
    onFirstFrame: () => undefined,
  });
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

/**
 * Let pending promise callbacks run without moving the clock.
 * @returns Once they have.
 */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await vi.advanceTimersByTimeAsync(0);
}

/**
 * The requests that reached the chat endpoint.
 * @returns Them, in order.
 */
function chatRequests(): Sent[] {
  return sent.filter((s) => s.url.endsWith('/chat/message'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  evictAllChatSessions();
  timing = DEFAULT_TIMING;
  sent = [];
  told = [];
  stopWatching = watchChatMishaps((mishap) => told.push(mishap));
  stubTransfer();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      sent.push({
        url: String(url),
        at: Date.now(),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        headers: new Headers(init?.headers),
        signal: init?.signal,
        push: (chunk) => controller?.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)),
        close: () => controller?.close(),
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }),
  );
});

afterEach(() => {
  stopWatching?.();
  evictAllChatSessions();
  assetsApi.resetUploadConfigCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('what a long chat message sends (W13, W14)', () => {
  it('W14 sends exactly {"transfer": key} as JSON once the upload ended transferred', async () => {
    openSession();
    void sendInSession(CONVERSATION, LONG);

    await advanceUntil(() => chatRequests().length > 0, 30_000);

    expect(seen.ticketBodies).toHaveLength(1);
    expect(seen.ticketBodies[0]).toMatchObject({ project_id: PROJECT });
    const [request] = chatRequests();
    expect(request?.body).toEqual({ transfer: KEY });
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.headers.get('accept-language')).toBe(getLocale());
  });

  it('W13 sends a short message in the same shape as before, with no transfer', async () => {
    openSession();
    void sendInSession(CONVERSATION, SHORT);

    await advanceUntil(() => chatRequests().length > 0, 1000);

    expect(seen.ticketBodies).toHaveLength(0);
    const [request] = chatRequests();
    expect(request?.body).toEqual({
      message: SHORT,
      project_id: PROJECT,
      conversation_id: CONVERSATION,
      attached_chips: [],
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(request?.headers.get('accept-language')).toBe(getLocale());
  });
});

describe('the heartbeat watchdog around an upload (H01-H03, H07, H08)', () => {
  it('H01 a 20 s upload does not get the turn given up on', async () => {
    openSession();
    const startedAt = Date.now();
    let ended = false;
    void sendInSession(CONVERSATION, LONG).then(() => {
      ended = true;
    });

    await advanceUntil(() => chatRequests().length > 0, 25_000);

    // Nothing was given up on while the upload ran.
    expect(told).toEqual([]);
    expect(seen.partSignals[0]?.aborted).toBe(false);
    const [request] = chatRequests();
    expect(request?.at).toBe(startedAt + 20_000);
    request?.push({ type: 'data-heartbeat', transient: true, data: {} });
    for (let beat = 0; beat < 6; beat++) {
      await vi.advanceTimersByTimeAsync(4000);
      expect(request?.signal?.aborted).toBe(false);
      request?.push({ type: 'data-heartbeat', transient: true, data: {} });
    }
    request?.close();
    await flush();

    expect(ended).toBe(true);
    expect(request?.signal?.aborted).toBe(false);
    expect(told.filter((m) => m.kind === 'network')).toEqual([]);
  });

  it('H02 counts the budget from the moment the request goes out', async () => {
    openSession();
    void sendInSession(CONVERSATION, LONG);

    await advanceUntil(() => chatRequests().length > 0, 25_000);
    const [request] = chatRequests();
    expect(seen.ticketBodies).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(BUDGET - 1);
    expect(request?.signal?.aborted).toBe(false);
    expect(told).toEqual([]);

    await vi.advanceTimersByTimeAsync(2);
    expect(request?.signal?.aborted).toBe(true);
    expect(told.map((m) => m.kind)).toEqual(['network']);
  });

  it('H03 does not count the upload even when the stream config answers late', async () => {
    timing = { ...DEFAULT_TIMING, config: 100, parts: [6000, 6000, 5000], wait: 1000 };
    vi.mocked(chatApi.streamConfig).mockImplementation(async () => {
      await sleep(3000);
      return { heartbeatIntervalMs: BEAT_MS, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000, spaceListMaxItems: 200 };
    });
    openSession();
    void sendInSession(CONVERSATION, LONG);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(chatRequests()).toHaveLength(0);
    expect(seen.ticketBodies).toHaveLength(1);
    expect(seen.partSignals[0]?.aborted).toBe(false);
    expect(told).toEqual([]);

    await advanceUntil(() => chatRequests().length > 0, 5000, 1);
    const [request] = chatRequests();
    await vi.advanceTimersByTimeAsync(BUDGET - 1);
    expect(request?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(request?.signal?.aborted).toBe(true);
    expect(told.map((m) => m.kind)).toEqual(['network']);
  });

  it('H07 a superseded turn finishing its upload late leaves the running turn\'s watch alone', async () => {
    // The fallback construction the spec allows: the first turn's upload
    // ignores cancellation and ends after the second turn has gone out, so
    // its pause (at its transfer start) and its restart (after its upload)
    // both arrive while the second turn is the one running.
    timing = { ...DEFAULT_TIMING, config: 1000, ticket: 1000, parts: [8000], finish: 1000, wait: 1000, ignoreAbort: true };
    openSession();
    const startedAt = Date.now();
    void sendInSession(CONVERSATION, LONG);
    await vi.advanceTimersByTimeAsync(500);
    void sendInSession(CONVERSATION, SHORT);

    await vi.advanceTimersByTimeAsync(15_500 - 500 - 1);
    const second = chatRequests().find((r) => (r.body as { message?: unknown }).message === SHORT);
    const abortedJustBefore = second?.signal?.aborted;
    const toldJustBefore = [...told];
    await vi.advanceTimersByTimeAsync(2);

    expect(Date.now()).toBe(startedAt + 15_501);
    // The first turn did go through a transfer, so its pause and restart ran.
    expect(seen.ticketBodies).toHaveLength(1);
    expect(seen.waits).toBe(1);
    expect(abortedJustBefore).toBe(false);
    expect(toldJustBefore).toEqual([]);
    expect(second?.signal?.aborted).toBe(true);
    expect(told.map((m) => m.kind)).toEqual(['network']);
  });

  it('H08 a short message is not paused: given up on BUDGET after the press', async () => {
    openSession();
    void sendInSession(CONVERSATION, SHORT);
    await flush();

    await vi.advanceTimersByTimeAsync(BUDGET + 1);

    const [request] = chatRequests();
    expect(request?.signal?.aborted).toBe(true);
    expect(told.map((m) => m.kind)).toEqual(['network']);
    expect(seen.ticketBodies).toHaveLength(0);
  });
});

describe('stopping a turn while its body uploads (H04-H06)', () => {
  /**
   * Start a long message and run fake time into its second part.
   * @returns Once the second part is being sent.
   */
  async function uploadIntoSecondPart(): Promise<void> {
    openSession();
    void sendInSession(CONVERSATION, LONG);
    await vi.advanceTimersByTimeAsync(timing.ticket + (timing.parts[0] ?? 0) + 1000);
  }

  /** What every way of stopping leaves behind on the request side. */
  function expectUploadStopped(): void {
    expect(seen.partsStarted).toBe(2);
    expect(seen.partSignals).toHaveLength(1);
    expect(seen.partSignals[0]?.aborted).toBe(true);
    expect(seen.finishes).toBe(0);
    expect(seen.waits).toBe(0);
    expect(chatRequests()).toHaveLength(0);
  }

  it('H04 stopChatSession stops the upload, says nothing, and the next message goes out', async () => {
    await uploadIntoSecondPart();
    expect(seen.partsStarted).toBe(2);

    stopChatSession(CONVERSATION);
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);

    expectUploadStopped();
    expect(told).toEqual([]);

    void sendInSession(CONVERSATION, SHORT);
    await advanceUntil(() => chatRequests().length > 0, 1000);
    expect(chatRequests().map((r) => (r.body as { message?: unknown }).message)).toEqual([SHORT]);
  });

  it('H05 evictChatSession stops the upload and leaves no watchdog behind', async () => {
    await uploadIntoSecondPart();

    evictChatSession(CONVERSATION);
    await flush();

    expectUploadStopped();
    expect(hasChatSession(CONVERSATION)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(told).toEqual([]);
    expect(chatRequests()).toHaveLength(0);
  });

  it('H06 leaving the project stops the upload the same way', async () => {
    useConversationRuntime.setState({
      conversations: {
        [CONVERSATION]: { projectId: PROJECT, messages: [], hasMore: false, oldestLoadedTurn: null, title: null },
      },
    });
    await uploadIntoSecondPart();

    conversationRuntime.leaveProject(PROJECT);
    await flush();

    expectUploadStopped();
    expect(hasChatSession(CONVERSATION)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(told).toEqual([]);
    expect(chatRequests()).toHaveLength(0);
  });
});

describe('a failed upload is said like any failed turn (W11)', () => {
  it('tells the turn failed and sends nothing to the chat endpoint', async () => {
    vi.mocked(apiPost).mockImplementation(async (url: string) => {
      throw new Error(`refused ${url}`);
    });
    openSession();
    void sendInSession(CONVERSATION, LONG);

    await vi.advanceTimersByTimeAsync(2000);

    expect(chatRequests()).toHaveLength(0);
    expect(told).toEqual([{ projectId: PROJECT, conversationId: CONVERSATION, kind: 'turn' }]);
  });
});
