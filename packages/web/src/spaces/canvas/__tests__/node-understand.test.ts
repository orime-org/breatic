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
import { AUDIO_FORMAT_NAMES, IMAGE_FORMAT_NAMES, VIDEO_FORMAT_NAMES } from '@breatic/shared';

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
  // about why, and the reason here is one sentence.
  it('refuses an audio format this endpoint does not take, and names the ones it does', () => {
    for (const mimeType of ['audio/mp4', 'audio/webm']) {
      expect(understandRefusal({ kind: 'audio', mimeType, sizeBytes: 1024 }, LIMIT)).toEqual({
        kind: 'format',
        formats: AUDIO_FORMAT_NAMES,
      });
    }
  });

  it('names the formats of the modality it refused, not some other one', () => {
    expect(
      understandRefusal({ kind: 'image', mimeType: 'image/avif', sizeBytes: 1024 }, LIMIT),
    ).toEqual({ kind: 'format', formats: IMAGE_FORMAT_NAMES });
    expect(
      understandRefusal({ kind: 'video', mimeType: 'video/x-msvideo', sizeBytes: 1024 }, LIMIT),
    ).toEqual({ kind: 'format', formats: VIDEO_FORMAT_NAMES });
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
    ).toEqual({ kind: 'format', formats: AUDIO_FORMAT_NAMES });
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

describe('the label on the menu item', () => {
  it('is translated in every locale we ship', () => {
    // A key present only in English renders in English everywhere else, and
    // nothing goes red: `t` falls back rather than failing. So the catalogs
    // are read directly.
    for (const [locale, catalog] of LOCALE_CATALOGS) {
      expect(
        readPath(catalog, 'canvas.nodeMenu.understand'),
        `${locale} is missing canvas.nodeMenu.understand`,
      ).toBeTypeOf('string');
    }
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
