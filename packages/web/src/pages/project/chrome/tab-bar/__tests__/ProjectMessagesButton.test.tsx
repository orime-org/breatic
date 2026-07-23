// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Activity feed panel tests (ADR 2026-07-04 project-activity-feed).
 * The panel reads REST keyset pages (mocked activitiesApi) instead of
 * the retired meta-doc projectMessages Y.Array.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  waitFor,
  type RenderOptions,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import type { ProjectActivityEntry } from '@breatic/shared';
import {
  ProjectMessagesButton,
  relativeTime,
  entryMessage,
  entryMedia,
} from '@web/pages/project/chrome/tab-bar/ProjectMessagesButton';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useUIStore } from '@web/stores/ui';

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));
vi.mock('@web/data/api/activities', () => ({
  activitiesApi: { list: listMock },
}));

const PID = '11111111-1111-4111-8111-111111111111';

/**
 * Renders with the providers the panel needs (tooltip + a fresh query
 * client so no cache leaks between tests).
 * @param ui - Element under test.
 * @param options - Optional RTL overrides.
 * @returns The RTL render result.
 */
function render(ui: React.ReactElement, options?: RenderOptions): ReturnType<typeof rtlRender> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
  return rtlRender(ui, { wrapper: Wrapper, ...options });
}

beforeEach(() => {
  useUIStore.setState({ activeOverlayId: null });
  listMock.mockReset();
  listMock.mockResolvedValue({ items: [], nextCursor: null });
});

/**
 * Build a feed entry with overridable fields.
 * @param over - Field overrides.
 * @returns A complete feed entry.
 */
function entry(over: Partial<ProjectActivityEntry>): ProjectActivityEntry {
  return {
    id: over.id ?? 'a-1',
    projectId: PID,
    actorUserId: 'u-1',
    actorName: 'Yuki',
    type: 'space:created',
    spaceId: null,
    nodeId: null,
    taskId: null,
    payload: {},
    restored: false,
    createdAt: Date.now() - 60_000,
    ...over,
  };
}

describe('ProjectMessagesButton (activity feed)', () => {
  it('renders the trigger without any unread indicator', () => {
    render(<ProjectMessagesButton projectId={PID} />);
    expect(screen.getByTestId('project-messages-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('project-messages-dot')).toBeNull();
  });

  it('opens as a modal sheet with a backdrop overlay, like dialogs', async () => {
    const user = userEvent.setup();
    render(<ProjectMessagesButton projectId={PID} />);
    await user.click(screen.getByTestId('project-messages-trigger'));
    expect(screen.getByTestId('sheet-overlay')).toBeInTheDocument();
  });

  it('fetches the first page on open and renders one row per entry', async () => {
    listMock.mockResolvedValue({
      items: [
        entry({ id: 'a-1', type: 'space:created', payload: { spaceName: 'Main' } }),
        entry({ id: 'a-2', type: 'asset:uploaded', payload: { fileUrl: 'https://x/f.png', kind: 'image' } }),
        entry({
          id: 'a-3',
          type: 'generation:succeeded',
          payload: { source: 'mini_tool', toolName: 'crop', executedOn: 'frontend' },
        }),
      ],
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(<ProjectMessagesButton projectId={PID} />);
    await user.click(screen.getByTestId('project-messages-trigger'));
    expect(await screen.findByTestId('project-messages-entry-a-1')).toBeInTheDocument();
    expect(screen.getByTestId('project-messages-entry-a-2')).toBeInTheDocument();
    expect(screen.getByTestId('project-messages-entry-a-3')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(PID, undefined);
  });

  it('shows the Restore button only for the owner on unconsumed space:deleted rows', async () => {
    const onRestore = vi.fn();
    listMock.mockResolvedValue({
      items: [
        entry({
          id: 'del-1',
          type: 'space:deleted',
          spaceId: 'sp-9',
          payload: { spaceName: 'Doomed', spaceSnapshot: { id: 'sp-9' } },
        }),
      ],
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(
      <ProjectMessagesButton projectId={PID} currentUserRole='owner' onRestore={onRestore} />,
    );
    await user.click(screen.getByTestId('project-messages-trigger'));
    const btn = await screen.findByTestId('project-messages-restore-del-1');
    await user.click(btn);
    expect(onRestore).toHaveBeenCalledWith('sp-9');
  });

  it('replaces Restore with a disabled restored badge when the row is consumed', async () => {
    listMock.mockResolvedValue({
      items: [
        entry({
          id: 'del-2',
          type: 'space:deleted',
          spaceId: 'sp-9',
          restored: true,
          payload: { spaceName: 'Back' },
        }),
      ],
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(<ProjectMessagesButton projectId={PID} currentUserRole='owner' />);
    await user.click(screen.getByTestId('project-messages-trigger'));
    expect(
      await screen.findByTestId('project-messages-restored-badge-del-2'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('project-messages-restore-del-2')).toBeNull();
  });

  it('hides Restore for non-owner viewers', async () => {
    listMock.mockResolvedValue({
      items: [
        entry({
          id: 'del-3',
          type: 'space:deleted',
          spaceId: 'sp-9',
          payload: { spaceName: 'Doomed' },
        }),
      ],
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(<ProjectMessagesButton projectId={PID} currentUserRole='viewer' />);
    await user.click(screen.getByTestId('project-messages-trigger'));
    await screen.findByTestId('project-messages-entry-del-3');
    expect(screen.queryByTestId('project-messages-restore-del-3')).toBeNull();
  });

  it('the activity:new stateless signal invalidates the feed (refetch)', async () => {
    type StatelessCb = (data: { payload: string }) => void;
    const listeners = new Map<string, StatelessCb>();
    const provider = {
      on: vi.fn((event: string, cb: (data: { payload: string }) => void) => {
        listeners.set(event, cb);
      }),
      off: vi.fn(),
    } as unknown as import('@hocuspocus/provider').HocuspocusProvider;
    const user = userEvent.setup();
    render(<ProjectMessagesButton projectId={PID} provider={provider} />);
    await user.click(screen.getByTestId('project-messages-trigger'));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    listeners.get('stateless')?.({
      payload: JSON.stringify({ t: 'activity:new', projectId: PID }),
    });
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));

    // Foreign / non-JSON stateless traffic is ignored.
    listeners.get('stateless')?.({ payload: 'not-json' });
    listeners.get('stateless')?.({
      payload: JSON.stringify({ t: 'activity:new', projectId: 'other' }),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(listMock).toHaveBeenCalledTimes(2);
  });
});

describe('entryMessage specificity (#1622)', () => {
  it('asset:uploaded → kind-specific key, generic fallback for file / none', () => {
    const key = (kind: string): string =>
      entryMessage(entry({ type: 'asset:uploaded', payload: { fileUrl: 'x', kind } })).key;
    expect(key('image')).toBe('activity.type.assetUploadedImage');
    expect(key('video')).toBe('activity.type.assetUploadedVideo');
    expect(key('audio')).toBe('activity.type.assetUploadedAudio');
    expect(key('file')).toBe('activity.type.assetUploaded');
  });

  it('generation:succeeded → kind-specific key; toolName still wins; generic fallback', () => {
    expect(
      entryMessage(entry({ type: 'generation:succeeded', payload: { source: 'task', kind: 'image' } })).key,
    ).toBe('activity.type.generationSucceededImage');
    expect(
      entryMessage(entry({ type: 'generation:succeeded', payload: { source: 'task', kind: 'audio' } })).key,
    ).toBe('activity.type.generationSucceededAudio');
    // A mini-tool with a tool name keeps its tool message (kind is secondary).
    expect(
      entryMessage(
        entry({ type: 'generation:succeeded', payload: { source: 'mini_tool', toolName: 'crop', kind: 'image' } }),
      ).key,
    ).toBe('activity.type.generationSucceededTool');
    // Non-media generation (understand) → generic.
    expect(
      entryMessage(entry({ type: 'generation:succeeded', payload: { source: 'understand' } })).key,
    ).toBe('activity.type.generationSucceeded');
  });

  it('specific keys keep the {actor} param', () => {
    expect(
      entryMessage(
        entry({ actorName: 'Ada', type: 'asset:uploaded', payload: { kind: 'video', fileUrl: 'x' } }),
      ).params.actor,
    ).toBe('Ada');
  });
});

describe('entryMedia (#1622)', () => {
  it('returns preview media for uploaded / generated image·video·audio', () => {
    expect(
      entryMedia(entry({ type: 'asset:uploaded', payload: { fileUrl: 'https://x/a.png', kind: 'image' } })),
    ).toEqual({ kind: 'image', src: 'https://x/a.png' });
    expect(
      entryMedia(
        entry({
          type: 'generation:succeeded',
          payload: { source: 'task', kind: 'video', fileUrl: 'https://x/v.mp4', thumbnailUrl: 'https://x/c.jpg' },
        }),
      ),
    ).toEqual({ kind: 'video', src: 'https://x/v.mp4', poster: 'https://x/c.jpg' });
    expect(
      entryMedia(
        entry({ type: 'generation:succeeded', payload: { source: 'task', kind: 'audio', fileUrl: 'https://x/s.mp3' } }),
      ),
    ).toEqual({ kind: 'audio', src: 'https://x/s.mp3' });
  });

  it('returns null for non-media rows (file kind, missing url, space / failed)', () => {
    expect(entryMedia(entry({ type: 'asset:uploaded', payload: { fileUrl: 'x', kind: 'file' } }))).toBeNull();
    // No fileUrl → no preview src.
    expect(entryMedia(entry({ type: 'generation:succeeded', payload: { source: 'task', kind: 'image' } }))).toBeNull();
    expect(entryMedia(entry({ type: 'space:created', payload: { spaceName: 'M' } }))).toBeNull();
    expect(entryMedia(entry({ type: 'generation:failed', payload: { source: 'task' } }))).toBeNull();
  });

  it('poster only for video (audio / image ignore thumbnailUrl)', () => {
    expect(
      entryMedia(
        entry({ type: 'generation:succeeded', payload: { source: 'task', kind: 'audio', fileUrl: 'x', thumbnailUrl: 'y' } }),
      ),
    ).toEqual({ kind: 'audio', src: 'x' });
  });
});

describe('activity feed row: thumbnail + credits (#1622)', () => {
  it('a media generation row shows a thumbnail and the credits it cost (raw value)', async () => {
    listMock.mockResolvedValue({
      items: [
        entry({
          id: 'g-1',
          type: 'generation:succeeded',
          payload: { source: 'task', kind: 'image', fileUrl: 'https://x/i.png', credits: 1.5 },
        }),
      ],
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(<ProjectMessagesButton projectId={PID} />);
    await user.click(screen.getByTestId('project-messages-trigger'));
    await screen.findByTestId('project-messages-entry-g-1');
    expect(screen.getByTestId('project-messages-thumb-g-1')).toBeInTheDocument();
    expect(screen.getByTestId('project-messages-credits-g-1')).toHaveTextContent('1.5');
  });

  it('plain rows (space / member) have no thumbnail and no credits', async () => {
    listMock.mockResolvedValue({
      items: [entry({ id: 's-1', type: 'space:created', payload: { spaceName: 'Main' } })],
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(<ProjectMessagesButton projectId={PID} />);
    await user.click(screen.getByTestId('project-messages-trigger'));
    await screen.findByTestId('project-messages-entry-s-1');
    expect(screen.queryByTestId('project-messages-thumb-s-1')).toBeNull();
    expect(screen.queryByTestId('project-messages-credits-s-1')).toBeNull();
  });

  it('credits shows 0 for a free generation but stays hidden for uploads (INV-8)', async () => {
    listMock.mockResolvedValue({
      items: [
        entry({
          id: 'z-1',
          type: 'generation:succeeded',
          payload: { source: 'task', kind: 'image', fileUrl: 'https://x/i.png', credits: 0 },
        }),
        entry({ id: 'u-1', type: 'asset:uploaded', payload: { fileUrl: 'https://x/u.png', kind: 'image' } }),
      ],
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(<ProjectMessagesButton projectId={PID} />);
    await user.click(screen.getByTestId('project-messages-trigger'));
    await screen.findByTestId('project-messages-entry-z-1');
    expect(screen.getByTestId('project-messages-credits-z-1')).toHaveTextContent('0');
    // An upload records no cost → no credits chip.
    expect(screen.queryByTestId('project-messages-credits-u-1')).toBeNull();
    // But an upload IS a media row → it still gets a thumbnail.
    expect(screen.getByTestId('project-messages-thumb-u-1')).toBeInTheDocument();
  });
});

describe('relativeTime', () => {
  it('buckets minutes / hours / days', () => {
    const now = 1_780_900_000_000;
    expect(relativeTime(now - 30_000, now).key).toBe('spaces.history.relative.justNow');
    expect(relativeTime(now - 5 * 60_000, now)).toEqual({
      key: 'spaces.history.relative.minutesAgo',
      params: { count: 5 },
    });
    expect(relativeTime(now - 3 * 3_600_000, now).key).toBe('spaces.history.relative.hoursAgo');
    expect(relativeTime(now - 3 * 86_400_000, now).key).toBe('spaces.history.relative.daysAgo');
  });
});
