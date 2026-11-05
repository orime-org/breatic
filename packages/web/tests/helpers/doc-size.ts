// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading a Space document's size as collab pushed it, and filling the
 * document towards its cap (inner#1790).
 *
 * The cases built on this never hard-code the cap: every target is derived
 * from what the Space's own `doc:size` push says (`readLines`), so they pass
 * under the default `max_document_bytes` and under any smaller one.
 *
 * The fill goes straight through the live `Y.Doc` (`getDoc(name).transact`),
 * not through `writeSpaceDoc`: it stands for content that was already in the
 * document, which the size gate under test never judged. It carries no
 * origin, so no undo manager tracks it. On a canvas it goes into unknown keys
 * of one filler node's data (`smokeFill0`, `smokeFill1`, …), so deleting that
 * node takes all of it away; elsewhere it goes into a root map
 * `doc.getMap('smoke-fill')`, which nothing on screen can delete.
 */
import { expect, type Page } from 'playwright/test';

import { CANVAS_SPACE, YJS_MANAGER, liveModuleUrl } from './live-module';
import type * as CanvasModule from '../../src/data/yjs/canvas-space';
import type * as CollabSocketModule from '../../src/data/yjs/collab-socket';
import type * as DocSizeModule from '../../src/data/yjs/doc-size';
import type * as ManagerModule from '../../src/data/yjs/manager';
import type { DocSizeState } from '../../src/data/yjs/doc-size';

export type { DocSizeState } from '../../src/data/yjs/doc-size';

/** The module holding every document's size, as the page loaded it. */
export const DOC_SIZE = 'data/yjs/doc-size.ts';

/** The one entry web writes Space documents through. */
export const SPACE_WRITE = 'data/yjs/space-write.ts';

/** The collab registry, which knows a document's receipts. */
export const COLLAB_SOCKET = 'data/yjs/collab-socket.tsx';

export const KiB = 1024;

/** The largest string one fill transaction writes. */
const CHUNK_BYTES = 512 * KiB;

/** How long a fill waits for the push that counts it (the spec's polling cap). */
const PUSH_WAIT_MS = 15_000;

/**
 * How long a reached target is left before it is trusted. Longer than
 * `document_size_measure_interval_ms` (2 s): a push right after a write
 * carries collab's upper bound, and the exact re-measure that follows within
 * that interval may come in lower.
 */
const SETTLE_MS = 2_500;

/** Where a fill goes: one canvas node's data, or the root `smoke-fill` map. */
export type FillTarget = { node: string } | 'smoke-fill';

/** The key every fill container is given first, for `pushPastLimit` to delete. */
const MARK_KEY = 'smokeMark';

/** The quantities a Space's lines are derived from, read in `normal`. */
export interface SizeLines {
  limit: number;
  ceiling: number;
  /** `limit − bytes − room`: how far below the limit the full line sits. */
  margin: number;
  /** `limit − margin`: from here the Space is `full`. */
  fullLine: number;
  /** `ceiling − bytes − overwriteRoom`: room kept below the ceiling for overwrites. */
  reserve: number;
}

/**
 * A document's size, as the page's own copy of `doc-size.ts` holds it.
 * @param page - A page with the Space open.
 * @param docName - The Space's content document name.
 * @returns The state and the numbers of the push in effect.
 */
export async function readSize(page: Page, docName: string): Promise<DocSizeState> {
  const at = await liveModuleUrl(page, DOC_SIZE);
  return page.evaluate(async ([url, name]) => {
    const sizes = (await import(/* @vite-ignore */ url)) as typeof DocSizeModule;
    return sizes.readDocSize(name);
  }, [at, docName] as const);
}

/**
 * The room left for new writes right now: the pushed room less what
 * reservations hold.
 * @param page - A page with the Space open.
 * @param docName - The Space's content document name.
 * @returns Bytes, or null while the size is unknown.
 */
export async function availableRoom(page: Page, docName: string): Promise<number | null> {
  const at = await liveModuleUrl(page, DOC_SIZE);
  return page.evaluate(async ([url, name]) => {
    const sizes = (await import(/* @vite-ignore */ url)) as typeof DocSizeModule;
    return sizes.availableRoom(name);
  }, [at, docName] as const);
}

/**
 * Wait for a push that shows the Space `normal` with room for adds and
 * overwrites, and derive its lines from it.
 * @param page - A page with the Space open.
 * @param docName - The Space's content document name.
 * @returns The lines.
 * @throws {Error} When no such push arrives in time.
 */
export async function readLines(page: Page, docName: string): Promise<SizeLines> {
  await expect
    .poll(async () => {
      const s = await readSize(page, docName);
      return s.phase === 'normal' && (s.limit ?? 0) > 0 && (s.room ?? 0) > 0 && (s.overwriteRoom ?? 0) > 0;
    }, { timeout: PUSH_WAIT_MS, message: 'the Space never reported a normal size with room left' })
    .toBe(true);
  const s = await readSize(page, docName);
  const limit = s.limit ?? 0;
  const ceiling = s.ceiling ?? 0;
  const bytes = s.bytes ?? 0;
  const margin = limit - bytes - (s.room ?? 0);
  return { limit, ceiling, margin, fullLine: limit - margin, reserve: ceiling - bytes - (s.overwriteRoom ?? 0) };
}

/**
 * Write strings into the fill container, one transaction each, straight into
 * the live document.
 * @param page - A page with the Space open.
 * @param docName - The Space's content document name.
 * @param where - The fill container.
 * @param sizes - Length of each string to add, one transaction per entry.
 * @param deleteMark - Also delete the container's mark key, in the first transaction.
 */
async function writeFill(
  page: Page,
  docName: string,
  where: FillTarget,
  sizes: readonly number[],
  deleteMark: boolean,
): Promise<void> {
  const managerAt = await liveModuleUrl(page, YJS_MANAGER);
  const canvasAt = where === 'smoke-fill' ? null : await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([mUrl, cUrl, name, target, lengths, mark, markKey]) => {
      const manager = (await import(/* @vite-ignore */ mUrl)) as typeof ManagerModule;
      if (!manager.hasDoc(name)) throw new Error(`${name} is not open in this page`);
      const doc = manager.getDoc(name);
      let map;
      if (target === 'smoke-fill') {
        map = doc.getMap<unknown>('smoke-fill');
      } else {
        const canvas = (await import(/* @vite-ignore */ cUrl as string)) as typeof CanvasModule;
        map = canvas.nodeDataMap(doc, target.node);
        if (map === null) throw new Error(`no node ${target.node} to fill`);
      }
      const fill = map;
      let next = 0;
      while (fill.has(`smokeFill${String(next)}`)) next += 1;
      lengths.forEach((length, i) => {
        doc.transact(() => {
          if (!fill.has(markKey)) fill.set(markKey, 'x');
          else if (mark && i === 0) fill.delete(markKey);
          fill.set(`smokeFill${String(next + i)}`, 'f'.repeat(length));
        });
      });
    },
    [managerAt, canvasAt, docName, where, sizes, deleteMark, MARK_KEY] as const,
  );
}

/**
 * Fill a Space's document until collab pushes a size of at least
 * `targetBytes`, and that size holds after the exact re-measure.
 * @param page - A page with the Space open, holding the filler node when `where` names one.
 * @param docName - The Space's content document name.
 * @param targetBytes - The size to reach; at most the limit, or collab refuses the fill.
 * @param where - The fill container.
 * @returns The size once it holds.
 * @throws {Error} When the target is past the limit, or a push never counts the fill.
 */
export async function fillTo(
  page: Page,
  docName: string,
  targetBytes: number,
  where: FillTarget,
): Promise<DocSizeState> {
  for (;;) {
    const now = await readSize(page, docName);
    if (now.bytes === null || now.limit === null) throw new Error(`${docName} has no size yet`);
    if (targetBytes > now.limit) throw new Error(`a fill to ${String(targetBytes)} is past the limit ${String(now.limit)}`);
    if (now.bytes >= targetBytes) {
      await page.waitForTimeout(SETTLE_MS);
      const settled = await readSize(page, docName);
      if ((settled.bytes ?? 0) >= targetBytes) return settled;
      continue;
    }
    const sizes: number[] = [];
    for (let left = targetBytes - now.bytes; left > 0; left -= CHUNK_BYTES) sizes.push(Math.min(CHUNK_BYTES, left));
    await writeFill(page, docName, where, sizes, false);
    await expect
      .poll(async () => (await readSize(page, docName)).bytes ?? 0, {
        timeout: PUSH_WAIT_MS,
        message: `the fill of ${docName} never reached ${String(targetBytes)} bytes`,
      })
      .toBeGreaterThanOrEqual(targetBytes);
  }
}

/**
 * Take a document past its limit in one update that also deletes existing
 * content (the fill container's mark key), which collab admits up to the hard
 * ceiling.
 * @param page - A page with the Space open, after a `fillTo` into the same container.
 * @param docName - The Space's content document name.
 * @param targetBytes - The size to land on, inside `(limit, ceiling]`.
 * @param where - The fill container `fillTo` wrote.
 * @returns The size once it holds.
 * @throws {Error} When the target is outside `(limit, ceiling]`, or no push shows the document past the limit.
 */
export async function pushPastLimit(
  page: Page,
  docName: string,
  targetBytes: number,
  where: FillTarget,
): Promise<DocSizeState> {
  const now = await readSize(page, docName);
  const { bytes, limit, ceiling } = now;
  if (bytes === null || limit === null || ceiling === null) throw new Error(`${docName} has no size yet`);
  if (targetBytes <= limit || targetBytes > ceiling) {
    throw new Error(`${String(targetBytes)} is not inside (${String(limit)}, ${String(ceiling)}]`);
  }
  await writeFill(page, docName, where, [targetBytes - bytes], true);
  await expect
    .poll(async () => (await readSize(page, docName)).bytes ?? 0, {
      timeout: PUSH_WAIT_MS,
      message: `${docName} never went past its limit`,
    })
    .toBeGreaterThan(limit);
  await page.waitForTimeout(SETTLE_MS);
  return readSize(page, docName);
}

/**
 * The live document's state vector, as text: it changes with every struct
 * the document gains, so equal readings mean nothing was written between them.
 * @param page - A page with the Space open.
 * @param docName - The Space's content document name.
 * @returns Each client's next clock, sorted by client.
 */
export async function stateVector(page: Page, docName: string): Promise<string> {
  const managerAt = await liveModuleUrl(page, YJS_MANAGER);
  return page.evaluate(async ([url, name]) => {
    const manager = (await import(/* @vite-ignore */ url)) as typeof ManagerModule;
    if (!manager.hasDoc(name)) throw new Error(`${name} is not open in this page`);
    // What `Y.encodeStateVector` encodes, read without a second copy of yjs.
    const clients = manager.getDoc(name).store.clients;
    const vector = [...clients.entries()].map(([client, structs]) => {
      const last = structs[structs.length - 1];
      return [client, last === undefined ? 0 : last.id.clock + last.length] as const;
    });
    return JSON.stringify(vector.sort((a, b) => a[0] - b[0]));
  }, [managerAt, docName] as const);
}

/**
 * Wait until collab has confirmed every local write of a document.
 * @param page - A page with the Space open.
 * @param docName - The Space's content document name.
 * @throws {Error} When the receipts never catch up.
 */
export async function docSynced(page: Page, docName: string): Promise<void> {
  const at = await liveModuleUrl(page, COLLAB_SOCKET);
  await expect
    .poll(() => page.evaluate(async ([url, name]) => {
      const socket = (await import(/* @vite-ignore */ url)) as typeof CollabSocketModule;
      const versions = socket.readDocVersions(name);
      return versions !== null && versions.confirmedVersion >= versions.localVersion;
    }, [at, docName] as const), { timeout: PUSH_WAIT_MS, message: `${docName} never got its receipts` })
    .toBe(true);
}
