// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A canvas tab publishes what its reader is waiting on with the tab, not with
 * the body on screen (inner#1303 §6.8): the line stays on the peers' screens
 * while the reader looks at another Space, and goes when the tab closes.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { _resetForTests } from '@web/data/yjs/manager';
import { OpenSpace } from '@web/pages/project/OpenSpace';
import { useUploadMarksStore } from '@web/stores/upload-marks';

const awareness = new Awareness(new Y.Doc());
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): { provider: { awareness: Awareness }; synced: boolean; hasEverSynced: boolean } => ({
    provider: { awareness },
    synced: true,
    hasEverSynced: true,
  }),
}));
vi.mock('@web/pages/project/SpaceOutlet', () => ({ SpaceOutlet: (): null => null }));

const PID = 'p-act';
const SID = 's-act';

beforeEach(() => {
  _resetForTests();
  useUploadMarksStore.setState({ marks: {} });
  awareness.setLocalState({});
});

afterEach(() => {
  _resetForTests();
});

/**
 * The activity this tab has published.
 * @returns The field, or null when nothing is published.
 */
const published = (): unknown => (awareness.getLocalState() as { activity?: unknown } | null)?.activity ?? null;

describe('a canvas tab', () => {
  it('keeps its activity published while another tab is on screen, and withdraws it when closed', async () => {
    const view = render(<OpenSpace projectId={PID} spaceId={SID} type='canvas' active visited />);
    await act(async () => {
      useUploadMarksStore.getState().begin(SID, 'n1', 'upload');
    });
    expect(published()).toEqual([expect.objectContaining({ nodeId: 'n1' })]);
    view.rerender(<OpenSpace projectId={PID} spaceId={SID} type='canvas' active={false} visited />);
    expect(published()).toEqual([expect.objectContaining({ nodeId: 'n1' })]);
    view.unmount();
    expect(published()).toBeNull();
  });
});
