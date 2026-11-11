// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading a Space document's size as collab pushed it, and filling a canvas
 * Space towards its cap (inner#1790).
 *
 * The cases built on this never hard-code the cap: every target is derived
 * from what the Space's own `doc:size` push says, so they run under the
 * default `max_document_bytes` with no configuration.
 *
 * The fill goes straight through the live `Y.Doc` (`getDoc(name).transact`),
 * not through `writeSpaceDoc`: it stands for content that was already in the
 * document, which the size gate under test never judged. It carries no
 * origin, so no undo manager tracks it. It goes into unknown keys of one
 * filler node's data (`smokeFill0`, `smokeFill1`, …), so deleting that node
 * takes all of it away.
 */
import { expect, type Page } from 'playwright/test';

import { CANVAS_SPACE, YJS_MANAGER, liveModuleUrl } from './live-module';
import type * as CanvasModule from '../../src/data/yjs/canvas-space';
import type * as DocSizeModule from '../../src/data/yjs/doc-size';
import type * as ManagerModule from '../../src/data/yjs/manager';
import type { DocSizeState } from '../../src/data/yjs/doc-size';

export type { DocSizeState } from '../../src/data/yjs/doc-size';

/** The module holding every document's size, as the page loaded it. */
export const DOC_SIZE = 'data/yjs/doc-size.ts';

export const KiB = 1024;

export const MiB = 1024 * KiB;

/** The largest string one fill transaction writes. */
const MAX_CHUNK_BYTES = MiB;

/** The fill stops once the push says less than this is left below the limit. */
export const FILL_STOP_BYTES = 32 * KiB;

/** How long a fill waits for the push that counts it. */
const PUSH_WAIT_MS = 5_000;

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

/** A size whose push carried numbers (anything but `unknown`). */
export interface KnownSize {
  phase: DocSizeState['phase'];
  overCeiling: boolean;
  bytes: number;
  limit: number;
  ceiling: number;
}

/**
 * The numbers of a size the page has a push for.
 * @param size - What `readSize` returned.
 * @returns The same size with its numbers present.
 * @throws {Error} When no push with numbers is in effect.
 */
export function knownSize(size: DocSizeState): KnownSize {
  const { bytes, limit, ceiling } = size;
  if (bytes === null || limit === null || ceiling === null) throw new Error(`no size pushed yet (phase ${size.phase})`);
  return { phase: size.phase, overCeiling: size.overCeiling, bytes, limit, ceiling };
}

/**
 * Write one string into a fresh fill key of the filler node, in one
 * transaction straight into the live document.
 * @param page - A page with the Space open.
 * @param docName - The Space's content document name.
 * @param node - The filler node.
 * @param length - The string's length (ASCII, so its bytes).
 */
async function writeFill(page: Page, docName: string, node: string, length: number): Promise<void> {
  const managerAt = await liveModuleUrl(page, YJS_MANAGER);
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([mUrl, cUrl, name, id, size]) => {
      const manager = (await import(/* @vite-ignore */ mUrl)) as typeof ManagerModule;
      const canvas = (await import(/* @vite-ignore */ cUrl)) as typeof CanvasModule;
      if (!manager.hasDoc(name)) throw new Error(`${name} is not open in this page`);
      const doc = manager.getDoc(name);
      const fill = canvas.nodeDataMap(doc, id);
      if (fill === null) throw new Error(`no node ${id} to fill`);
      let next = 0;
      while (fill.has(`smokeFill${String(next)}`)) next += 1;
      doc.transact(() => {
        fill.set(`smokeFill${String(next)}`, 'f'.repeat(size));
      });
    },
    [managerAt, canvasAt, docName, node, length] as const,
  );
}

/** What a fill below the limit went through. */
export interface FillResult {
  /** A push said `warning` at some point on the way. */
  sawWarning: boolean;
  /** The size once the fill stopped. */
  last: DocSizeState;
}

/**
 * Fill a canvas Space's document to just below its limit (spec 2.2
 * `fillToBelowLimit`): each write is a quarter of what the push says is left
 * (at most 1 MiB), so the fill itself never crosses the limit; it waits for
 * the push that counts each write and stops once less than
 * {@link FILL_STOP_BYTES} is left.
 * @param page - A page with the Space open, holding the filler node.
 * @param docName - The Space's content document name.
 * @param node - The filler node, whose data takes the fill.
 * @returns Whether a push said `warning` on the way, and the size at the end.
 * @throws {Error} When the size is unknown, or a push never counts a write.
 */
export async function fillToBelowLimit(page: Page, docName: string, node: string): Promise<FillResult> {
  let sawWarning = false;
  for (;;) {
    const now = await readSize(page, docName);
    if (now.phase === 'warning') sawWarning = true;
    if (now.limit === null || now.bytes === null || now.limit <= 0) throw new Error(`${docName} has no size limit pushed (phase ${now.phase})`);
    const counted = now.bytes;
    const left = now.limit - counted;
    if (left < FILL_STOP_BYTES) return { sawWarning, last: now };
    await writeFill(page, docName, node, Math.min(MAX_CHUNK_BYTES, Math.floor(left / 4)));
    await expect
      .poll(async () => (await readSize(page, docName)).bytes, {
        timeout: PUSH_WAIT_MS,
        message: `no push counted the fill of ${docName} (was ${String(counted)} bytes)`,
      })
      .not.toBe(counted);
  }
}
