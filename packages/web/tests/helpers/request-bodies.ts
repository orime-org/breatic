// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the request-body specs drive and record (inner#1006): a text node
 * written straight into its Space's document, copied and pasted, kept as a
 * snapshot, and the requests the page sent while it happened.
 *
 * The body limit decides by what the page sends, so the evidence is the
 * request itself: every call to the transfer ticket, the paste, the snapshot
 * and the chat message is recorded with its body and its answer.
 */
import { expect, type Page } from 'playwright/test';

import { CANVAS_SPACE, TEXT_BODY, liveModuleUrl } from './live-module';
import { visibleSpace } from './space';

/** The API paths these specs watch. */
export const TRANSFER_TICKET = '/api/v1/assets/transfer-ticket';
export const PASTE = '/api/v1/canvas/paste';
export const SNAPSHOT = '/api/v1/canvas/node-history/snapshot';
export const CHAT_MESSAGE = '/api/v1/chat/message';

/** What a body sent as a transfer reference looks like on the wire. */
export const TRANSFER_REFERENCE = /^\{"transfer":"transfer\/[^"]+\.transfer"\}$/;

/** One request the page sent to a watched path. */
export interface SentRequest {
  path: string;
  method: string;
  body: string | null;
  /** The answer's status, or null while none has arrived. */
  status: number | null;
}

/** What the page did while a case ran. */
export interface PageRecord {
  requests: SentRequest[];
  consoleErrors: string[];
  pageErrors: string[];
}

/**
 * Start recording the watched requests and every console error of a page.
 * Called before the case acts, so nothing it causes is missed.
 * @param page - The page.
 * @returns The record, filled in as the page works.
 */
export function recordPage(page: Page): PageRecord {
  const record: PageRecord = { requests: [], consoleErrors: [], pageErrors: [] };
  const watched = new Set([TRANSFER_TICKET, PASTE, SNAPSHOT, CHAT_MESSAGE]);
  const byRequest = new Map<unknown, SentRequest>();
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!watched.has(path)) return;
    const sent: SentRequest = { path, method: request.method(), body: request.postData(), status: null };
    byRequest.set(request, sent);
    record.requests.push(sent);
  });
  page.on('response', (response) => {
    const sent = byRequest.get(response.request());
    if (sent) sent.status = response.status();
  });
  page.on('console', (message) => {
    if (message.type() === 'error') record.consoleErrors.push(message.text());
  });
  page.on('pageerror', (err) => record.pageErrors.push(err.message));
  return record;
}

/**
 * The recorded requests to one path.
 * @param record - What the page did.
 * @param path - The API path.
 * @returns Those requests, in the order they were sent.
 */
export function sentTo(record: PageRecord, path: string): SentRequest[] {
  return record.requests.filter((r) => r.path === path);
}

/**
 * Add a text node holding these words, written into its body the way the
 * editor stores them, and wait until the node shows its first words.
 * @param page - A page showing the canvas Space.
 * @param at - The project, the Space and the new node's id.
 * @param at.projectId - The project.
 * @param at.spaceId - The canvas Space.
 * @param at.nodeId - The node's id (a uuid, as history keys it).
 * @param words - What the node holds.
 */
export async function addTextNode(
  page: Page,
  at: { projectId: string; spaceId: string; nodeId: string },
  words: string,
): Promise<void> {
  const canvasUrl = await liveModuleUrl(page, CANVAS_SPACE);
  const bodyUrl = await liveModuleUrl(page, TEXT_BODY);
  await page.evaluate(
    async ([pid, sid, id, text, canvasAt, bodyAt]) => {
      const canvas = (await import(/* @vite-ignore */ canvasAt)) as {
        addNode: (p: string, s: string, n: unknown) => void;
        getTextBody: (p: string, s: string, id: string) => unknown;
      };
      const body = (await import(/* @vite-ignore */ bodyAt)) as {
        writePlainTextIntoBody: (b: unknown, t: string) => void;
      };
      canvas.addNode(pid, sid, {
        id, type: 'text', position: { x: 0, y: 0 },
        data: { name: 'transfer-e2e', createdAt: Date.now(), createdBy: 'transfer-e2e', locked: false, attachments: [] },
      });
      body.writePlainTextIntoBody(canvas.getTextBody(pid, sid, id), text);
    },
    [at.projectId, at.spaceId, at.nodeId, words, canvasUrl, bodyUrl] as const,
  );
  await expect(visibleSpace(page).locator(`.react-flow__node[data-id="${at.nodeId}"]`)).toContainText(words.slice(0, 15), {
    timeout: 20_000,
  });
}

/**
 * A text node's words as plain text, read from the document.
 * @param page - A page showing the canvas Space.
 * @param at - The project, the Space and the node.
 * @param at.projectId - The project.
 * @param at.spaceId - The canvas Space.
 * @param at.nodeId - The node.
 * @returns Its words, or the empty string when it has no body.
 */
export async function textOf(
  page: Page,
  at: { projectId: string; spaceId: string; nodeId: string },
): Promise<string> {
  const canvasUrl = await liveModuleUrl(page, CANVAS_SPACE);
  const bodyUrl = await liveModuleUrl(page, TEXT_BODY);
  return page.evaluate(
    async ([pid, sid, id, canvasAt, bodyAt]) => {
      const canvas = (await import(/* @vite-ignore */ canvasAt)) as {
        getTextBody: (p: string, s: string, id: string) => unknown;
      };
      const body = (await import(/* @vite-ignore */ bodyAt)) as { bodyToPlainText: (b: unknown) => string };
      const fragment = canvas.getTextBody(pid, sid, id);
      return fragment === undefined || fragment === null ? '' : body.bodyToPlainText(fragment);
    },
    [at.projectId, at.spaceId, at.nodeId, canvasUrl, bodyUrl] as const,
  );
}

/**
 * The ids of every node in the canvas document.
 * @param page - A page showing the canvas Space.
 * @param projectId - The project.
 * @param spaceId - The canvas Space.
 * @returns The ids.
 */
export async function nodeIds(page: Page, projectId: string, spaceId: string): Promise<string[]> {
  const canvasUrl = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, canvasAt]) => {
      const canvas = (await import(/* @vite-ignore */ canvasAt)) as {
        readCanvasGraph: (p: string, s: string) => { nodes: Array<{ id: string }> };
      };
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => n.id);
    },
    [projectId, spaceId, canvasUrl] as const,
  );
}

/**
 * Select a node by clicking its top edge, where no control sits, then copy
 * and paste it from the keyboard.
 * @param page - A page showing the canvas Space.
 * @param nodeId - The node to copy.
 * @throws {Error} When the node is not on screen.
 */
export async function copyAndPaste(page: Page, nodeId: string): Promise<void> {
  const at = await uncoveredPoint(page, nodeId);
  await page.mouse.click(at.x, at.y);
  await expect(visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`)).toHaveClass(/selected/);
  await page.keyboard.press('ControlOrMeta+C');
  await page.keyboard.press('ControlOrMeta+V');
}

/**
 * Keep a node's words from its context menu.
 * @param page - A page showing the canvas Space.
 * @param nodeId - The node.
 */
export async function keepSnapshot(page: Page, nodeId: string): Promise<void> {
  await openNodeMenu(page, nodeId);
  await page.getByTestId('node-menu-snapshot').click();
}

/**
 * Right-click a node where nothing else covers it, opening its menu.
 * @param page - A page showing the canvas Space.
 * @param nodeId - The node.
 */
export async function openNodeMenu(page: Page, nodeId: string): Promise<void> {
  const at = await uncoveredPoint(page, nodeId);
  await page.mouse.click(at.x, at.y, { button: 'right' });
}

/**
 * A point on a node's edge strip that hits the node itself. A pasted copy
 * lands overlapping its original, so the centre of one can sit under the
 * other; each candidate is checked with a hit test before it is used.
 * @param page - A page showing the canvas Space.
 * @param nodeId - The node.
 * @returns The point, in page coordinates.
 * @throws {Error} When the node is off screen or covered at every candidate.
 */
async function uncoveredPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  const box = await visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
  if (box === null) throw new Error(`node ${nodeId} is not on screen`);
  const candidates = [
    { x: box.x + 12, y: box.y + 6 },
    { x: box.x + box.width / 2, y: box.y + 6 },
    { x: box.x + box.width - 12, y: box.y + 6 },
    { x: box.x + 12, y: box.y + box.height - 6 },
    { x: box.x + 6, y: box.y + box.height / 2 },
  ];
  for (const point of candidates) {
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('.react-flow__node')?.getAttribute('data-id') ?? null,
      point,
    );
    if (hit === nodeId) return point;
  }
  throw new Error(`node ${nodeId} is covered at every point tried`);
}

/** One row of a node's history, as the history endpoint answers it. */
export interface HistoryEntry {
  entryType: string;
  content: string | null;
}

/**
 * A node's history, newest first.
 * @param page - A signed-in page.
 * @param projectId - The project.
 * @param nodeId - The node.
 * @returns The entries.
 */
export async function historyOf(page: Page, projectId: string, nodeId: string): Promise<HistoryEntry[]> {
  const answer = await page.request.get(`/api/v1/canvas/nodes/${nodeId}/history`, {
    params: { project_id: projectId, limit: 20, offset: 0 },
  });
  expect(answer.ok()).toBe(true);
  return ((await answer.json()) as { data: { entries: HistoryEntry[] } }).data.entries;
}

/**
 * The parts of a long text a comparison reads: its length and its first and
 * last 64 characters. Comparing these instead of the whole keeps a failure
 * readable when the text is a megabyte long.
 * @param text - The text.
 * @returns Its length, head and tail.
 */
export function outline(text: string): { length: number; head: string; tail: string } {
  return { length: text.length, head: text.slice(0, 64), tail: text.slice(-64) };
}
