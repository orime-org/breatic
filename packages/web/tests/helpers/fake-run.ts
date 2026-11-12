// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Answer the page's sends with runs written here, the way the server answers
 * them (inner#1717): `POST /chat/message` says the run started, the page reads
 * the newest page of history back, and the run's frames come from
 * `GET /chat/conversations/:id/stream`, opening with a heartbeat.
 *
 * The message never reaches the server, so reading a conversation's history
 * back adds what the store would hold by then: each message sent to it, and
 * each reply written here that has been read. A card's answer is stored on
 * the card, never streamed: a card run's `tool-output-available` frame for
 * that card is applied to the card in the history instead. The run it resumes
 * writes a reply of its own, as the server stores it. A second send then
 * finds the first turn still on screen.
 */
import { attachmentPart, type ChatAttachedChip } from '@breatic/shared';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import type { Page, Route } from 'playwright/test';

/** The heartbeat every run's stream opens with. */
export const RUN_BEAT = { type: 'data-heartbeat', transient: true, data: {} };

/** What one send is answered with: the run's frames after its heartbeat. */
export type RunFrames = object[];

/** What the faked sends were sent with, and how to stop faking them. */
export interface FakeRuns {
  /** The body of every send, in order. */
  bodies: Array<Record<string, unknown>>;
  /**
   * Frames for a run no send opens.
   * @param frames - The run's frames.
   * @param conversationId - Its conversation; the last one sent to when left out.
   */
  queue: (frames: RunFrames, conversationId?: string) => void;
  /** Take this helper's routes off the page. */
  stop: () => Promise<void>;
}

/** A stored row as the history read answers it. */
interface StoredRow {
  id: string;
  role: 'user' | 'assistant';
  parts: unknown[];
  metadata: { turnIndex: number; ts: string };
}

/** A row this helper keeps for a conversation, before it is given a turn. */
type KeptRow = Omit<StoredRow, 'metadata'>;

/** The paths this helper answers. */
const MESSAGE = '**/chat/message';
const STREAM = /\/chat\/conversations\/([^/]+)\/stream$/;
const HISTORY = /\/chat\/conversations\/([^/]+)$/;

/** A card's answer, as a frame names it. */
interface Settled {
  type: 'tool-output-available';
  toolCallId: string;
  output: unknown;
}

/**
 * Settle a card in the rows kept, as the server stores an answer: the call
 * holds its output, and the mark naming it as the card shown goes.
 * @param rows - The rows kept for the conversation.
 * @param answer - The answer.
 */
function settleCard(rows: KeptRow[], answer: Settled): void {
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    row.parts = row.parts
      .filter((p) => !((p as { type?: string; data?: { toolCallId?: string } }).type === 'data-ask-awaiting' && (p as { data?: { toolCallId?: string } }).data?.toolCallId === answer.toolCallId))
      .map((p) => ((p as { toolCallId?: string }).toolCallId === answer.toolCallId ? { ...(p as object), state: 'output-available', output: answer.output } : p));
  }
}

/**
 * The reply a run's frames build.
 * @param frames - The run's frames.
 * @returns The reply, or null when the frames build none.
 */
async function replyOf(frames: RunFrames): Promise<UIMessage | null> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const f of frames) controller.enqueue(f as UIMessageChunk);
      controller.close();
    },
  });
  let last: UIMessage | null = null;
  try {
    for await (const message of readUIMessageStream({ stream })) last = message;
  } catch {
    // A run that ends in an error frame keeps what it built until then.
  }
  return last;
}

/**
 * Answer every send on this page with the frames `framesFor` gives it.
 * @param page - The signed-in page.
 * @param framesFor - The run a send opens: its frames after the heartbeat.
 * @returns What was sent, a way to start a run no send opens, and a way to stop.
 */
export async function answerRuns(
  page: Page,
  framesFor: (body: Record<string, unknown>, index: number) => RunFrames,
): Promise<FakeRuns> {
  const bodies: Array<Record<string, unknown>> = [];
  const waiting = new Map<string, RunFrames[]>();
  const kept = new Map<string, KeptRow[]>();
  let lastConversation = '';

  /**
   * The rows kept for a conversation.
   * @param conversationId - The conversation.
   * @returns Its rows, created empty.
   */
  const rowsOf = (conversationId: string): KeptRow[] => {
    let rows = kept.get(conversationId);
    if (rows === undefined) kept.set(conversationId, (rows = []));
    return rows;
  };

  /**
   * Answer a send.
   * @param route - The routed request.
   * @returns When it is answered.
   */
  const onMessage = async (route: Route): Promise<void> => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const index = bodies.length;
    bodies.push(body);
    const conversationId = String(body.conversation_id ?? '');
    lastConversation = conversationId;
    const card = 'answer' in body || 'shared_spaces' in body;
    if (!card && typeof body.id === 'string') {
      const chips = (body.attached_chips as ChatAttachedChip[] | undefined) ?? [];
      rowsOf(conversationId).push({
        id: body.id,
        role: 'user',
        parts: [...chips.map(attachmentPart), { type: 'text', text: String(body.message ?? '') }],
      });
    }
    let frames = framesFor(body, index);
    if (card) {
      const answered = ((body.answer ?? body.shared_spaces) as { toolCallId?: string }).toolCallId;
      const isAnswer = (f: object): boolean =>
        (f as Partial<Settled>).type === 'tool-output-available' && (f as Partial<Settled>).toolCallId === answered;
      for (const f of frames.filter(isAnswer)) settleCard(rowsOf(conversationId), f as Settled);
      frames = frames.filter((f) => !isAnswer(f));
    }
    const runs = waiting.get(conversationId) ?? [];
    runs.push(frames);
    waiting.set(conversationId, runs);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { status: 'start', pending: [], running: true } }) });
  };

  /**
   * Answer a run's stream.
   * @param route - The routed request.
   * @returns When it is answered.
   */
  const onStream = async (route: Route): Promise<void> => {
    const conversationId = STREAM.exec(new URL(route.request().url()).pathname)?.[1] ?? '';
    const frames = waiting.get(conversationId)?.shift();
    if (frames === undefined) return route.fulfill({ status: 204 });
    const reply = await replyOf(frames);
    if (reply !== null) rowsOf(conversationId).push({ id: reply.id, role: 'assistant', parts: reply.parts });
    const body = [RUN_BEAT, ...frames].map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
  };

  /**
   * Answer a history read with what the store would hold.
   * @param route - The routed request.
   * @returns When it is answered.
   */
  const onHistory = async (route: Route): Promise<void> => {
    const conversationId = HISTORY.exec(new URL(route.request().url()).pathname)?.[1] ?? '';
    const rows = kept.get(conversationId) ?? [];
    if (route.request().method() !== 'GET' || rows.length === 0) return route.fallback();
    const response = await route.fetch();
    const read = (await response.json()) as { data: { messages: StoredRow[] } };
    const have = new Set(read.data.messages.map((m) => m.id));
    let turn = Math.max(0, ...read.data.messages.map((m) => m.metadata.turnIndex));
    for (const row of rows) {
      if (have.has(row.id)) continue;
      if (row.role === 'user') turn += 1;
      read.data.messages.push({ ...row, metadata: { turnIndex: turn, ts: new Date().toISOString() } });
    }
    await route.fulfill({ response, json: read });
  };

  await page.route(MESSAGE, onMessage);
  await page.route(STREAM, onStream);
  await page.route(HISTORY, onHistory);

  return {
    bodies,
    queue: (frames, conversationId = lastConversation) => {
      const runs = waiting.get(conversationId) ?? [];
      runs.push(frames);
      waiting.set(conversationId, runs);
    },
    stop: async () => {
      await page.unroute(MESSAGE, onMessage);
      await page.unroute(STREAM, onStream);
      await page.unroute(HISTORY, onHistory);
    },
  };
}

/**
 * Hold every run's stream at one frame until the case lets it go, so what the
 * page shows while the run is at that point can be looked at.
 *
 * `route.fulfill` hands the page a stream's whole body at once, so a state
 * that lasts only between two frames is never drawn. The page's own `fetch`,
 * which the chat transport calls, re-streams the body in two parts.
 * @param page - The page, before it loads.
 * @param after - The text of the frame to hold after; the heartbeat when left out.
 * @returns A function that lets the held stream go on.
 */
export async function holdRunStreams(page: Page, after?: string): Promise<() => Promise<void>> {
  await page.addInitScript((marker: string | null) => {
    const held = window as unknown as { releaseRun?: () => void };
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await real(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (!/\/chat\/conversations\/[^/]+\/stream$/.test(url.pathname) || res.status !== 200) return res;
      const text = await res.text();
      const cut = text.indexOf('\n\n', marker === null ? 0 : text.indexOf(marker)) + 2;
      const released = new Promise<void>((resolve) => {
        held.releaseRun = resolve;
      });
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(text.slice(0, cut)));
          await released;
          controller.enqueue(encoder.encode(text.slice(cut)));
          controller.close();
        },
      });
      return new Response(body, { status: res.status, headers: res.headers });
    };
  }, after ?? null);
  return async () => {
    await page.evaluate(() => (window as unknown as { releaseRun?: () => void }).releaseRun?.());
  };
}
