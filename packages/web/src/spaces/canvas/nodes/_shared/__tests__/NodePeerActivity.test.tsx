// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What an empty node shows other people while someone fills it (inner#1303
 * §6.8, A14): "{name} is {doing}" in place of the call to action, for the
 * person who started last, only on a node with no tasks, never over the
 * viewer's own waiting skeleton, and over the viewer's own failure line.
 */

import { act, render, screen } from '@testing-library/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', async (original) => ({ ...(await original<object>()), useNodeId: () => 'n1' }));

import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';
import type { PeerActivity } from '@web/spaces/canvas/node-activity';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import {
  NodeBusyContext,
  PeerActivityContext,
} from '@web/spaces/canvas/nodes/_shared/node-peer-activity-context';
import { useUploadMarksStore } from '@web/stores/upload-marks';

const NAMES: CollaboratorNames = {
  resolve: (userId: string) => (userId === 'bob' ? 'Bob' : null),
  members: [],
};

/**
 * Render an empty image node among people doing things.
 * @param table - Node id to the person shown working on it.
 * @param busy - Whether the node has tasks.
 * @returns The rendered tree.
 */
function renderAmong(table: PeerActivity, busy = false): ReturnType<typeof render> {
  const tree = (
    <CollaboratorNamesProvider value={NAMES}>
      <PeerActivityContext.Provider value={table}>
        <NodeBusyContext.Provider value={busy}>
          <NodePlaceholder modality='image' />
        </NodeBusyContext.Provider>
      </PeerActivityContext.Provider>
    </CollaboratorNamesProvider>
  ) as React.ReactElement;
  return render(tree);
}

beforeEach(() => {
  useUploadMarksStore.setState({ marks: {} });
});

describe('an empty node someone else is filling', () => {
  it('says who is uploading in place of the call to action', () => {
    renderAmong(new Map([['n1', { userId: 'bob', action: 'upload', at: 1 }]]));
    expect(screen.getByText('Bob is uploading')).toBeInTheDocument();
    expect(screen.queryByText(/double-click to upload/i)).toBeNull();
    expect(screen.getByText(/right-click to generate/i)).toBeInTheDocument();
  });

  it('says who is reading a file', () => {
    renderAmong(new Map([['n1', { userId: 'bob', action: 'readText', at: 1 }]]));
    expect(screen.getByText('Bob is reading the file')).toBeInTheDocument();
  });

  it('names the tool someone is running', () => {
    renderAmong(new Map([['n1', { userId: 'bob', action: 'image.grid', at: 1 }]]));
    expect(screen.getByText('Bob is running Grid split')).toBeInTheDocument();
  });

  it('keeps the call to action for someone the roster cannot name', () => {
    renderAmong(new Map([['n1', { userId: 'stranger', action: 'upload', at: 1 }]]));
    expect(screen.getByText(/double-click to upload/i)).toBeInTheDocument();
  });

  it('keeps the call to action on a node with tasks', () => {
    renderAmong(new Map([['n1', { userId: 'bob', action: 'upload', at: 1 }]]), true);
    expect(screen.queryByText('Bob is uploading')).toBeNull();
  });

  it('keeps the call to action when the activity is on another node', () => {
    renderAmong(new Map([['n2', { userId: 'bob', action: 'upload', at: 1 }]]));
    expect(screen.getByText(/double-click to upload/i)).toBeInTheDocument();
  });

  it('shows the viewer their own skeleton instead', () => {
    act(() => {
      useUploadMarksStore.getState().begin('', 'n1', 'upload');
    });
    renderAmong(new Map([['n1', { userId: 'bob', action: 'upload', at: 1 }]]));
    expect(screen.getByTestId('node-upload-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Bob is uploading')).toBeNull();
  });

  // The viewer's failure line is about an operation that ended; someone
  // filling the node now is what the viewer needs to know before trying again.
  it('says who is filling the node over the viewer’s own failure line, which comes back after', () => {
    let id = '';
    act(() => {
      id = useUploadMarksStore.getState().begin('', 'n1', 'upload');
      useUploadMarksStore.getState().fail('', 'n1', id, { key: 'canvas.upload.failed' });
    });
    const rendered = renderAmong(new Map([['n1', { userId: 'bob', action: 'upload', at: 1 }]]));
    expect(screen.getByText('Bob is uploading')).toBeInTheDocument();
    expect(screen.queryByTestId('node-upload-error')).toBeNull();
    rendered.unmount();
    renderAmong(new Map());
    expect(screen.getByTestId('node-upload-error')).toBeInTheDocument();
  });

  it('keeps the double-click working while it shows', () => {
    const onActivate = vi.fn();
    render(
      <CollaboratorNamesProvider value={NAMES}>
        <PeerActivityContext.Provider value={new Map([['n1', { userId: 'bob', action: 'upload', at: 1 }]])}>
          <NodePlaceholder modality='image' onActivate={onActivate} />
        </PeerActivityContext.Provider>
      </CollaboratorNamesProvider>,
    );
    act(() => {
      screen.getByTestId('node-placeholder').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(onActivate).toHaveBeenCalledOnce();
  });
});
