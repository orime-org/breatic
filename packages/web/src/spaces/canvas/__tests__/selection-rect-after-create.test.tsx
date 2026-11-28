// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * xyflow's marquee rect after a creation (inner#2216). A marquee leaves
 * xyflow's NodesSelection active; when what a press makes next is one thing,
 * the rect would shrink onto it and take its presses, so the canvas clears it
 * as a click-selected node has none. Several copies keep it so they move
 * together, and a marquee that ends on one node leaves none over it.
 *
 * The canvas is mounted for real on a real canvas document, and the marquee
 * is dragged on the pane, because the rect is xyflow's own state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(
    (): ReturnType<typeof import('@web/data/yjs/use-socket').useSocket> => ({
      provider: null,
      synced: false,
      hasEverSynced: false,
      status: 'connecting',
      writeAccess: 'unknown',
      authFailedReason: null,
    }),
  ),
}));
vi.mock('@web/data/yjs/space-connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/yjs/space-connection')>();
  const { useSocket } = await import('@web/data/yjs/use-socket');
  return { ...actual, useSpaceConnection: () => useSocket({ name: '', doc: undefined as never }) };
});
// Dropped files only need their nodes and Group written; the bytes never go.
vi.mock('@web/data/upload/hash', () => ({ hashFile: vi.fn(() => new Promise<string | null>(() => {})) }));
vi.mock('@web/spaces/canvas/text-extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/spaces/canvas/text-extract')>();
  return { ...actual, extractText: vi.fn(() => new Promise<string>(() => {})) };
});
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

import type { CanvasNodeFields } from '@breatic/shared';
import { assetsApi } from '@web/data/api';
import { canvasApi } from '@web/data/api/canvas';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode, readNodes, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useUIStore } from '@web/stores';
import { canvasGraphs } from '@web/stores/canvas-graph';
import { useCurrentUserStore } from '@web/stores/current-user';

const PID = 'p';
const SID = 's';

/**
 * Seeds picture nodes in a row and mounts the real canvas once they are on it.
 * @param ids - The nodes to seed.
 * @throws {Error} When mounting fails.
 */
async function mountWith(ids: readonly string[]): Promise<void> {
  getDoc(docName.canvasSpace(PID, SID));
  ids.forEach((id, i) => {
    addNode(PID, SID, {
      id,
      type: 'image',
      position: { x: i * 400, y: 0 },
      data: { name: id, createdAt: 1, createdBy: 'u-1', locked: false, attachments: [], content: `https://cdn.example.test/${id}.png` },
    } as CanvasNodeFields);
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div data-region='space'>
        <CanvasSpace projectId={PID} spaceId={SID} readOnly={false} />
      </div>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(canvasGraphs.of(SID).getState().flowNodes).toHaveLength(ids.length));
}

/**
 * A pointer event the pane reads as a primary press.
 * @param type - The event type.
 * @param x - Client x.
 * @param y - Client y.
 * @returns The event.
 */
function pointer(type: string, x: number, y: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'isPrimary', { value: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

/**
 * Drops two files on the canvas, which builds them inside one Group.
 */
function dropTwoFiles(): void {
  const files = [new File(['x'], 'a.png', { type: 'image/png' }), new File(['hello'], 'b.txt', { type: 'text/plain' })];
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { configurable: true, value: { files, types: ['Files'] } });
  Object.defineProperty(event, 'clientX', { configurable: true, value: 10 });
  Object.defineProperty(event, 'clientY', { configurable: true, value: 10 });
  act(() => {
    screen.getByTestId('canvas-space').dispatchEvent(event);
  });
}

/** Duplicates the selection with Cmd/Ctrl+D. */
function duplicate(): void {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
}

/** Drags a marquee over the whole board; each step is its own act. */
function marqueeAll(): void {
  const pane = document.querySelector('.react-flow__pane');
  if (!pane) throw new Error('the pane is not mounted');
  for (const [type, x, y] of [['pointerdown', 1, 1], ['pointermove', 50, 50], ['pointermove', 5000, 5000], ['pointerup', 5000, 5000]] as const) {
    act(() => {
      pane.dispatchEvent(pointer(type, x, y));
    });
  }
}

const rect = (): Element | null => document.querySelector('.react-flow__nodesselection-rect');

const selectedIds = (): string[] =>
  canvasGraphs.of(SID).getState().flowNodes.filter((n) => n.selected === true).map((n) => n.id).sort();

beforeEach(() => {
  useUIStore.setState({ activeRegion: 'space' });
  useCurrentUserStore.getState().setUser({ id: 'u-1', name: 'Ada', email: 'ada@example.com', personalStudio: null, membershipTier: 'base' });
  vi.spyOn(canvasApi, 'paste').mockResolvedValue({ map: {}, media: {} });
  vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue({
    maxUploadBytes: 2147483648,
    clientMaxAttempts: 1,
    clientRetryBaseDelayMs: 1,
    uploadIdleTimeoutMs: 60000,
    assetUrlPrefix: 'https://cdn/',
  });
  vi.spyOn(assetsApi, 'requestUploadTicket').mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.restoreAllMocks();
});

describe('the marquee rect after a creation (inner#2216)', () => {
  // The marquee's nodes stay selected until the Group the drop wraps comes
  // back from the document, and a Group is never the lone node the handles'
  // plus is for, so only the one-thing-made rule clears the rect over it.
  it('clears the rect when files dropped after a marquee land in one Group, selected alone', async () => {
    await mountWith(['a', 'b']);
    marqueeAll();
    expect(rect()).not.toBeNull();

    dropTwoFiles();
    let group = '';
    await waitFor(() => {
      group = readNodes(getDoc(docName.canvasSpace(PID, SID))).find((n) => n.type === 'group')?.id ?? '';
      expect(group).not.toBe('');
    });
    await waitFor(() => expect(selectedIds()).toEqual([group]));
    await waitFor(() => expect(rect()).toBeNull());
  });

  it('keeps the rect around two copies a duplicate of a marquee makes', async () => {
    await mountWith(['a', 'b']);
    marqueeAll();
    expect(rect()).not.toBeNull();

    duplicate();
    await waitFor(() => expect(readNodes(getDoc(docName.canvasSpace(PID, SID)))).toHaveLength(4));
    const copies = readNodes(getDoc(docName.canvasSpace(PID, SID))).map((n) => n.id).filter((id) => id !== 'a' && id !== 'b').sort();
    await waitFor(() => expect(selectedIds()).toEqual(copies));
    expect(rect()).not.toBeNull();
  });

  it('leaves no rect over the one node a marquee ends on', async () => {
    await mountWith(['a']);
    marqueeAll();
    expect(selectedIds()).toEqual(['a']);
    await waitFor(() => expect(rect()).toBeNull());
  });
});
