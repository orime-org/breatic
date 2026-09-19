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

import { understandRefusal } from '@web/spaces/canvas/node-understand';

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
