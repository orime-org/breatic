// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two questions the browser can answer about Understand on its own.
 *
 * A file this endpoint would refuse is refused here, before a request travels
 * and before a task row exists to carry the refusal — which is why the answer
 * is a toast and no node is built (downstream-node-creation decision, stage 1).
 * Everything the browser cannot answer for itself belongs to the run, and
 * lands on that run's row.
 */

import { describe, expect, it } from 'vitest';
import {
  understandNodePosition,
  understandRefusal,
} from '@web/spaces/canvas/node-understand';
import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

const LIMIT = 20 * 1024 * 1024;

describe('what the browser refuses before it builds anything', () => {
  it('lets through a file in a format this endpoint reads', () => {
    expect(
      understandRefusal({ kind: 'image', mimeType: 'image/png', sizeBytes: 1024 }, LIMIT),
    ).toBeNull();
    expect(
      understandRefusal({ kind: 'video', mimeType: 'video/quicktime', sizeBytes: 1024 }, LIMIT),
    ).toBeNull();
    expect(
      understandRefusal({ kind: 'audio', mimeType: 'audio/x-wav', sizeBytes: 1024 }, LIMIT),
    ).toBeNull();
  });

  // The two audio types that upload and play but cannot be understood. They
  // stay clickable on purpose (user 2026-09-19): a disabled item says nothing
  // about why, and the reason here is one sentence. That sentence names the
  // file in hand, which is the thing the reader acts on (user 2026-09-20).
  it('names the format of the file it refused', () => {
    expect(
      understandRefusal({ kind: 'audio', mimeType: 'audio/mp4', sizeBytes: 1024 }, LIMIT),
    ).toEqual({ kind: 'format', format: 'M4A' });
    expect(
      understandRefusal({ kind: 'audio', mimeType: 'audio/webm', sizeBytes: 1024 }, LIMIT),
    ).toEqual({ kind: 'format', format: 'WebM' });
  });

  // Most of what a refusal is handed has no entry in that table: the types it
  // lists are the ones we take. The subtype in capitals is the word anybody
  // would use for the file, once the registry prefix an .avi arrives under is
  // off it.
  it('falls back to the subtype for a format we have no word for', () => {
    expect(
      understandRefusal({ kind: 'image', mimeType: 'image/avif', sizeBytes: 1024 }, LIMIT),
    ).toEqual({ kind: 'format', format: 'AVIF' });
    expect(
      understandRefusal({ kind: 'video', mimeType: 'video/x-msvideo', sizeBytes: 1024 }, LIMIT),
    ).toEqual({ kind: 'format', format: 'MSVIDEO' });
  });

  it('refuses a file over the cap, and says how big it is', () => {
    expect(
      understandRefusal({ kind: 'image', mimeType: 'image/png', sizeBytes: LIMIT + 1 }, LIMIT),
    ).toEqual({ kind: 'size', limitBytes: LIMIT, sizeBytes: LIMIT + 1 });
  });

  it('lets a file exactly at the cap through', () => {
    expect(
      understandRefusal({ kind: 'image', mimeType: 'image/png', sizeBytes: LIMIT }, LIMIT),
    ).toBeNull();
  });

  // Format first: a file that is both too large and in a format this endpoint
  // cannot read is not fixed by shrinking it.
  it('answers the format when a file fails both', () => {
    expect(
      understandRefusal({ kind: 'audio', mimeType: 'audio/webm', sizeBytes: LIMIT + 1 }, LIMIT),
    ).toEqual({ kind: 'format', format: 'WebM' });
  });

  // A node stored before the ledger reported either. The browser has nothing
  // to say about it, so it says nothing and the run answers instead — the
  // alternative is refusing every node that predates those fields.
  it('refuses nothing it was not told', () => {
    expect(
      understandRefusal({ kind: 'image', mimeType: undefined, sizeBytes: 1024 }, LIMIT),
    ).toBeNull();
    expect(
      understandRefusal({ kind: 'image', mimeType: 'image/png', sizeBytes: undefined }, LIMIT),
    ).toBeNull();
  });
});

// The menu item and the four lines a press is answered with. A key present only
// in English renders in English everywhere else, and nothing goes red: `t`
// falls back rather than failing. So the catalogs are read directly.
describe.each([
  'canvas.nodeMenu.understand',
  'canvas.understand.unsupportedFormat',
  'canvas.understand.tooLarge',
  'canvas.understand.couldNotStart',
  'canvas.understand.sourceGone',
])('%s', (key) => {
  it.each(LOCALE_CATALOGS)('is written in %s', (locale, catalog) => {
    expect(readPath(catalog, key), `${locale} is missing ${key}`).toBeTypeOf(
      'string',
    );
  });
});

describe('where the text node lands', () => {
  // One neighbour to the right, level with it — the same step a dropped batch
  // puts between neighbours, so the two read as a row rather than two
  // unrelated placements. Fixed, with no search for a free spot: a second run
  // lands on the first (user 2026-09-19), and the reader sorts out the stack.
  it('sits one step to the right of the node it reads', () => {
    expect(understandNodePosition({ x: 100, y: 40 }, null)).toEqual({
      x: 100 + NODE_STEP.x,
      y: 40,
    });
  });

  // A node inside a group stores its position relative to the group's origin
  // (`canvas-space.ts` restores `p.x + groupPos.x` when a group is dissolved).
  // The new node is top-level, so its position is absolute — adding the step
  // to the stored one would land it a whole group-origin away from the node
  // it belongs beside.
  it('converts a grouped source to absolute before stepping', () => {
    expect(understandNodePosition({ x: 10, y: 5 }, { x: 600, y: 300 })).toEqual({
      x: 610 + NODE_STEP.x,
      y: 305,
    });
  });

  it('puts a second run in the same place as the first', () => {
    const source = { x: 100, y: 40 };
    expect(understandNodePosition(source, null)).toEqual(
      understandNodePosition(source, null),
    );
  });
});

describe('what a missing ceiling does and does not switch off', () => {
  // The ceiling rides on knobs the canvas fetches; a press made before they
  // arrive reads null. Format needs no ceiling to judge, so refusing to
  // judge it would let a press through that the browser could have settled
  // — and A17 says that press builds nothing and says what the file is in.
  it('still refuses a format the endpoint cannot read', () => {
    expect(
      understandRefusal({ kind: 'audio', mimeType: 'audio/mp4', sizeBytes: 1024 }, null),
    ).toMatchObject({ kind: 'format' });
  });

  // Size is the half that needs the number. Without it the run is the judge,
  // which is what a node carrying no recorded size already does (§8.2).
  it('lets a file of any size through', () => {
    expect(
      understandRefusal(
        { kind: 'image', mimeType: 'image/png', sizeBytes: 999_999_999 },
        null,
      ),
    ).toBeNull();
  });
});
