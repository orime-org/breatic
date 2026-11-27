// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A Project video placed on a Timeline is stored by its address with its media facts, taken from the list item the
 * user picked (inner#2171 design §3.1, §4): no asset id, and the name the list shows or the file's own name.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TimelineVideoSourceSchema, type ProjectRegisteredAsset } from '@breatic/shared';
import { initializeTimelineDocument } from '@breatic/shared/space-content';

import { prepareTimelineMediaPlacement } from '@web/spaces/timeline/prepare-media-placement';

const SOURCE_ID = '10000000-0000-4000-8000-000000000001';
const ASSET: ProjectRegisteredAsset = {
  assetId: '20000000-0000-4000-8000-000000000001',
  projectReferenceId: '50000000-0000-4000-8000-000000000001',
  displayName: 'beach.mp4',
  kind: 'video',
  fileUrl: 'https://cdn.example/assets/abc123.mp4',
  coverUrl: 'https://cdn.example/assets/abc123_cover.jpg',
  width: 1280,
  height: 720,
  durationSeconds: 2,
  mimeType: 'video/mp4',
  sizeBytes: 8192,
};
const docs: Y.Doc[] = [];

afterEach(() => {
  docs.splice(0).forEach((doc) => doc.destroy());
});

/**
 * The source a placement of `asset` would write.
 * @param asset - The picked list item.
 * @param decodedDurationSeconds - A duration the browser read, when the list has none.
 * @returns The source record.
 */
function sourceFor(asset: ProjectRegisteredAsset, decodedDurationSeconds?: number): Record<string, unknown> {
  const doc = new Y.Doc();
  docs.push(doc);
  initializeTimelineDocument(doc, { width: 1920, height: 1080, fps: { num: 24, den: 1 } });
  const result = prepareTimelineMediaPlacement(doc, {
    asset, trackId: 'main', startFrame: 0, clipId: '30000000-0000-4000-8000-000000000001', sourceId: SOURCE_ID, canWrite: true,
    placement: { magnet: false, linkage: false }, ...(decodedDurationSeconds === undefined ? {} : { decodedDurationSeconds }),
  });
  if (!result.ok || result.command.operation !== 'add_video') throw new Error('placement refused');
  return result.command.parameters.source as unknown as Record<string, unknown>;
}

describe('a placed Project video is stored by its address (inner#2171)', () => {
  it('stores the address, cover, name, type and size of the picked list item', () => {
    const source = sourceFor(ASSET);
    expect(source).toMatchObject({
      url: ASSET.fileUrl, coverUrl: ASSET.coverUrl, name: 'beach.mp4', mimeType: 'video/mp4', width: 1280, height: 720,
      durationSeconds: '2', durationOrigin: 'registered',
    });
    expect(source).not.toHaveProperty('assetId');
    expect(TimelineVideoSourceSchema.safeParse(source).success).toBe(true);
  });

  it('names an unnamed item after its file', () => {
    expect(sourceFor({ ...ASSET, displayName: null }).name).toBe('abc123.mp4');
  });

  it('measures an item without a duration by the one the browser read', () => {
    expect(sourceFor({ ...ASSET, durationSeconds: null }, 4.2)).toMatchObject({ durationSeconds: '4.2', durationOrigin: 'decoded' });
  });
});
