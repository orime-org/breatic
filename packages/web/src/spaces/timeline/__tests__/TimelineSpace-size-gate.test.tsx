// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec W-92: moving a clip's start frame is an
 * overwrite. It goes through while overwrite room is left and, once it is
 * gone, only warns: the typed value stays and the field shows no error.
 */

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import type * as ProviderModule from '@hocuspocus/provider';
import type { ProjectRegisteredAsset, TimelineVideoClip, TimelineVideoSource } from '@breatic/shared';
import { applyTimelineEdit, initializeTimelineDocument, readTimelineDocument } from '@breatic/shared/space-content';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/api/timeline')>();
  return { ...actual, timelineApi: { ...actual.timelineApi, listVideos: vi.fn(), resolveAsset: vi.fn(), limits: vi.fn() } };
});

import { toast } from '@web/lib/toast';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { timelineApi } from '@web/data/api/timeline';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import type { SocketState } from '@web/data/yjs/use-socket';
import { TimelineSpace } from '@web/spaces/timeline/TimelineSpace';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import { COPY_EN, F_FULL, F_FULL_NEAR, type DocSizePush } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const NAME = docName.timelineSpace(PROJECT, SPACE);
const SETTINGS = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const ASSET: ProjectRegisteredAsset = {
  assetId: '20000000-0000-4000-8000-000000000001',
  projectReferenceId: '50000000-0000-4000-8000-000000000001',
  displayName: 'Product launch.mp4', kind: 'video',
  fileUrl: 'https://cdn.example/registered-launch.mp4',
  coverUrl: 'https://cdn.example/registered-launch.jpg',
  width: 1280, height: 720, durationSeconds: 2, mimeType: 'video/mp4', sizeBytes: 8192,
};
const SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000001', kind: 'video', assetId: ASSET.assetId,
  timebase: SETTINGS.fps, extentFrames: 48, durationSeconds: '2', durationOrigin: 'registered',
};
const CLIP: TimelineVideoClip = {
  id: '30000000-0000-4000-8000-000000000001', kind: 'video', trackId: 'visual-1', sourceId: SOURCE.id,
  startFrame: 0, sourceInFrame: 0, durationFrames: 48, rate: { num: 1, den: 1 }, gain: 1, mute: false,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};
const CONNECTED: SocketState = {
  provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null,
};
const clients: QueryClient[] = [];

/**
 * Seeds a Timeline holding clip c1 at frame 0 (written while the size state
 * is unknown), delivers one push and renders the real Space body.
 * @param push - The size push.
 * @returns The Timeline document.
 * @throws {Error} When seeding or rendering fails.
 */
function timelineAt(push: DocSizePush): Y.Doc {
  const { doc, provider } = openSizedDoc(NAME);
  const server = new Y.Doc();
  initializeTimelineDocument(server, SETTINGS);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server), 'provider');
  server.destroy();
  expect(applyTimelineEdit(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP } })).toBe(true);
  pushSize(provider, push);
  vi.mocked(toast.warning).mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={CONNECTED}>
    <TimelineSpace projectId={PROJECT} spaceId={SPACE} readOnly={false} myRole='editor' />
  </SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>);
  return doc;
}

/**
 * Selects c1, opens its start-frame editor, types 24 and applies it.
 * @throws {Error} When a control is unreachable.
 */
async function moveStartTo24(): Promise<void> {
  fireEvent.click(await screen.findByTestId('timeline-clip-' + CLIP.id));
  fireEvent.click(screen.getByTestId('timeline-edit-start'));
  fireEvent.change(screen.getByTestId('timeline-start-frame'), { target: { value: '24' } });
  fireEvent.click(screen.getByTestId('timeline-apply-start'));
}

beforeEach(() => {
  sizeGateProviders.length = 0;
  vi.mocked(timelineApi.resolveAsset).mockReset().mockResolvedValue(ASSET);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  _resetCollabSocketForTests();
  _resetForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('W-92 timeline set_start is an overwrite', () => {
  it('moves the clip at full while overwrite room is left', async () => {
    const doc = timelineAt(F_FULL);
    await moveStartTo24();
    expect(readTimelineDocument(doc).clips[CLIP.id]?.startFrame).toBe(24);
    expect(screen.queryByTestId('timeline-start-frame')).toBe(null);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('only warns once the overwrite room is gone, keeping the typed value without an error state', async () => {
    const doc = timelineAt(F_FULL_NEAR);
    await moveStartTo24();
    expect(readTimelineDocument(doc).clips[CLIP.id]?.startFrame).toBe(0);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_TIMELINE_FULL);
    expect(toast.error).not.toHaveBeenCalled();
    const input = screen.getByTestId('timeline-start-frame');
    expect(input).toHaveValue(24);
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Enter a valid start frame.')).toBe(null);
  });
});
