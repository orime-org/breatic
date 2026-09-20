// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press of Snapshot (#2175).
 *
 * What it keeps is what the node says at the moment of the press. The menu
 * may have been open for a while — a collaborator types, a reading lands —
 * and the words it showed when it opened are not what the reader is asking
 * to keep.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/data/yjs/canvas-space', () => ({
  readTextBodies: vi.fn(() => new Map<string, string>()),
}));
vi.mock('@web/data/api/canvas', () => ({
  canvasApi: { snapshotNodeText: vi.fn(async () => ({ id: 'h-1' })) },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { canvasApi } from '@web/data/api/canvas';
import { readTextBodies } from '@web/data/yjs/canvas-space';
import { toast } from '@web/lib/toast';

import { keepSnapshot } from '@web/spaces/canvas/keep-snapshot';

const PRESS = {
  projectId: 'p-1',
  spaceId: 's-1',
  nodeId: 'n-1',
  onKept: (): void => {},
};

describe('keeping what a text node says', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readTextBodies).mockReturnValue(new Map([['n-1', 'what it says now']]));
  });

  it('keeps the words the node holds at the moment of the press', async () => {
    await keepSnapshot(PRESS);

    expect(vi.mocked(readTextBodies)).toHaveBeenCalledWith('p-1', 's-1', ['n-1']);
    expect(vi.mocked(canvasApi.snapshotNodeText)).toHaveBeenCalledWith({
      project_id: 'p-1',
      node_id: 'n-1',
      text: 'what it says now',
    });
  });

  // A node emptied while the menu stood open has nothing to keep, and the
  // row it would write would hold nothing.
  it('keeps nothing when the node says nothing', async () => {
    vi.mocked(readTextBodies).mockReturnValue(new Map([['n-1', '']]));

    await keepSnapshot(PRESS);

    expect(vi.mocked(canvasApi.snapshotNodeText)).not.toHaveBeenCalled();
  });

  it('tells the reader when the row could not be written', async () => {
    vi.mocked(canvasApi.snapshotNodeText).mockRejectedValueOnce(new Error('offline'));

    await keepSnapshot(PRESS);

    expect(vi.mocked(toast.error)).toHaveBeenCalled();
  });

  // The panel beside the node is showing a list that predates this row, and
  // its own refetch watches runs — a snapshot is not one.
  it('tells the panel a row it does not know about now exists', async () => {
    const onKept = vi.fn();

    await keepSnapshot({ ...PRESS, onKept });

    expect(onKept).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success)).toHaveBeenCalled();
  });
});
