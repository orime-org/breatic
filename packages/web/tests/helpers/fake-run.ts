// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Answer the page's sends with runs written here, the way the server answers
 * them (inner#1717): `POST /chat/message` says the run started, the page reads
 * the newest page of history back, and the run's frames come from
 * `GET /chat/conversations/:id/stream`, opening with a heartbeat.
 *
 * The message never reaches the server, so reading the history back adds what
 * the store would hold by then: each message sent, and each reply written
 * here that has been read to its end. A second send then finds the first
 * turn still on screen.
 */
import { attachmentPart, type ChatAttachedChip } from '@breatic/shared';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import type { Page, Route } from 'playwright/test';

/** The heartbeat every run's stream opens with. */
export const RUN_BEAT = { type: 'data-heartbeat', transient: true, data: {} };

/** What one send is answered with: the run's frames after its heartbeat. */
export type RunFrames = object[];

/** What the faked sends were sent with and answered. */
export interface FakeRuns {
  /** The body of every send, in order. */
  bodies: Array<Record<string, unknown>>;
  /** Frames for runs not started by a send, such as a card's answer. */
  queue: (frames: RunFrames) => void;
}

/** A stored row as the history read answers it. */
interface StoredRow {
  id: string;
  role: 'user' | 'assistant';
  parts: unknown[];
  metadata: { turnIndex: number; ts: string };
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
 * @returns What was sent, and a way to start a run no send opens.
 */
export async function answerRuns(
  page: Page,
  framesFor: (body: Record<string, unknown>, index: number) => RunFrames,
): Promise<FakeRuns> {
  const bodies: Array<Record<string, unknown>> = [];
  const waiting: RunFrames[] = [];
  const kept: Array<Omit<StoredRow, 'metadata'> & { reply: boolean }> = [];

  await page.route('**/chat/message', async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const index = bodies.length;
    bodies.push(body);
    const isCard = 'answer' in body || 'shared_spaces' in body;
    if (!isCard && typeof body.id === 'string') {
      const chips = (body.attached_chips as ChatAttachedChip[] | undefined) ?? [];
      kept.push({
        id: body.id,
        role: 'user',
        parts: [...chips.map(attachmentPart), { type: 'text', text: String(body.message ?? '') }],
        reply: false,
      });
    }
    waiting.push(framesFor(body, index));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { status: 'start', pending: [], running: true } }) });
  });

  await page.route(/\/chat\/conversations\/[^/]+\/stream$/, async (route: Route) => {
    const frames = waiting.shift();
    if (frames === undefined) return route.fulfill({ status: 204 });
    const reply = await replyOf(frames);
    if (reply !== null) kept.push({ id: reply.id, role: 'assistant', parts: reply.parts, reply: true });
    const body = [RUN_BEAT, ...frames].map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
  });

  await page.route(/\/chat\/conversations\/[^/]+$/, async (route: Route) => {
    if (route.request().method() !== 'GET' || kept.length === 0) return route.fallback();
    const response = await route.fetch();
    const read = (await response.json()) as { data: { messages: StoredRow[] } };
    const have = new Set(read.data.messages.map((m) => m.id));
    let turn = Math.max(0, ...read.data.messages.map((m) => m.metadata.turnIndex));
    for (const row of kept) {
      if (have.has(row.id)) continue;
      if (row.role === 'user') turn += 1;
      read.data.messages.push({ id: row.id, role: row.role, parts: row.parts, metadata: { turnIndex: turn, ts: new Date().toISOString() } });
    }
    await route.fulfill({ response, json: read });
  });

  return { bodies, queue: (frames) => waiting.push(frames) };
}
