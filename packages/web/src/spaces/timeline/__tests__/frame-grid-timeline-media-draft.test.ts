// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * frames-split design §7.8 surface list row for `timeline-media-draft.ts`: a Project video placed on a Timeline whose
 * registration carries no duration takes its length from the selected version's grid (P.display), the length every other
 * surface plays; only while nothing is selected is the original decoded for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { QueryClient } from '@tanstack/react-query';
import type { ProjectRegisteredAsset } from '@breatic/shared';
import type * as TimelineApiModule from '@web/data/api/timeline';

const { resolveAsset } = vi.hoisted(() => ({ resolveAsset: vi.fn() }));
vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, resolveAsset } };
});

import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { readTimelineDocument } from '@web/data/yjs/timeline-document';
import { evictTimelineEditSession, getTimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import { getTimelineMediaDraft } from '@web/spaces/timeline/timeline-media-draft';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import { MAIN, ON, seededDoc, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { enterSize } from '@web/data/yjs/__tests__/helpers/size-v2-harness';
import { presentedBinding, presentedBundle, presentedDisplay, presentedResponse } from '@web/test-utils/video-presentation';

const PROJECT = 'p1';
const SPACE = 't1';
const NAME = docName.timelineSpace(PROJECT, SPACE);
const ASSET: ProjectRegisteredAsset = {
  assetId: '20000000-0000-4000-8000-000000000021', projectReferenceId: '50000000-0000-4000-8000-000000000021', displayName: 'Alpha.mov', kind: 'video',
  fileUrl: 'https://cdn.example/alpha-original.mov', coverUrl: null, width: 96, height: 64, durationSeconds: null, mimeType: 'video/quicktime', sizeBytes: 8192,
};
let client: QueryClient;
let decoded: string[];

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  decoded = [];
  resolveAsset.mockResolvedValue(ASSET);
  // The original, were it decoded, reports 9 s.
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(9);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement): void {
    const src = this.getAttribute('src');
    if (src !== null) { decoded.push(src); queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
  });
});
afterEach(() => { client.clear(); evictTimelineEditSession(NAME); clearAllDocSizes(); _resetForTests(); vi.restoreAllMocks(); });

/**
 * Places the Project video through the real material draft and edit session.
 * @returns The placed source's duration in seconds.
 */
async function place(): Promise<number> {
  const doc = getDoc(NAME);
  const seeded = seededDoc(timeline([], [{ id: MAIN, kind: 'visual', order: 0 }], []));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seeded), 'remote');
  seeded.destroy();
  const session = getTimelineEditSession(doc, NAME);
  session.setCanWrite(true);
  enterSize(NAME, 'N');
  const draft = getTimelineMediaDraft(doc, NAME, { projectId: PROJECT, spaceId: SPACE, queryClient: client, edit: (command, options) => session.edit(command, options), startUpload: vi.fn() });
  draft.setCanWrite(true);
  draft.open(0, MAIN);
  draft.setMode('project');
  draft.select(ASSET);
  await draft.confirm(ON);
  const sources = Object.values(readTimelineDocument(doc).sources);
  expect(sources).toHaveLength(1);
  return Number(sources[0]!.durationSeconds);
}

describe('a Project video without a registered duration (frames-split §7.8)', () => {
  it('MD01 takes the selected version grid length and decodes nothing', async () => {
    // 75 grid frames at 25 fps: 3 s.
    client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: ASSET.fileUrl, active: true }).queryKey,
      presentedResponse(presentedBinding(ASSET.fileUrl), { presentation: presentedBundle(ASSET.fileUrl, { display: presentedDisplay(96, 64, 75) }) }));
    expect(await place()).toBe(3);
    expect(decoded).not.toContain(ASSET.fileUrl);
  });

  it('MD02 with nothing selected decodes the original for its length', async () => {
    client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: ASSET.fileUrl, active: true }).queryKey, presentedResponse(presentedBinding(ASSET.fileUrl)));
    expect(await place()).toBe(9);
    expect(decoded).toContain(ASSET.fileUrl);
  });
});
