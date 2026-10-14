// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a node shows for the uploader's own mark (inner#1303 §6.7): a
 * skeleton while it waits for the server's answer, and a line saying what
 * went wrong when it ended before that. Nodes without a mark look as before.
 */

import { act, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', async (original) => ({ ...(await original<object>()), useNodeId: () => 'n1' }));

import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { useUploadMarksStore } from '@web/stores/upload-marks';

/** The marks store's actions; the canvas context's Space is '' outside a canvas. */
const marks = () => useUploadMarksStore.getState();

beforeEach(() => {
  useUploadMarksStore.setState({ marks: {} });
});

describe('an empty node with an upload mark', () => {
  it('shows a skeleton in place of the call to action while it waits', () => {
    act(() => {
      marks().begin('', 'n1', 'upload');
    });
    render(<NodePlaceholder modality='image' />);
    expect(screen.getByTestId('node-upload-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/double-click to upload/i)).toBeNull();
  });

  it('says what went wrong when it failed before the answer', () => {
    act(() => {
      const op = marks().begin('', 'n1', 'upload');
      marks().fail('', 'n1', op, { key: 'canvas.upload.failed' });
    });
    render(<NodePlaceholder modality='image' />);
    expect(screen.getByTestId('node-upload-error')).toHaveTextContent('Upload failed.');
  });

  it('goes back to the call to action once answered', () => {
    let op = '';
    act(() => {
      op = marks().begin('', 'n1', 'upload');
    });
    render(<NodePlaceholder modality='image' />);
    act(() => marks().answer('', 'n1', op));
    expect(screen.queryByTestId('node-upload-skeleton')).toBeNull();
    expect(screen.getByText(/double-click to upload/i)).toBeInTheDocument();
  });
});

/**
 * Render a node through the frame every content modality shares.
 * @param modality - The node's modality.
 * @param body - What the node shows.
 */
function renderFramed(modality: 'image' | 'video' | 'audio' | 'text', body: React.ReactNode): void {
  render(
    <ReactFlowProvider>
      <ContentNodeFrame modality={modality}>{body}</ContentNodeFrame>
    </ReactFlowProvider>,
  );
}

describe('every content node with an upload mark', () => {
  it.each(['image', 'video', 'audio', 'text'] as const)('lays a skeleton over a %s node that shows something', (modality) => {
    act(() => {
      marks().begin('', 'n1', 'upload');
    });
    renderFramed(modality, <p>held content</p>);
    expect(screen.getAllByTestId('node-upload-skeleton')).toHaveLength(1);
  });

  it.each(['image', 'video', 'audio', 'text'] as const)('says what went wrong on a %s node that shows something', (modality) => {
    act(() => {
      const op = marks().begin('', 'n1', 'upload');
      marks().fail('', 'n1', op, { key: 'canvas.upload.failed' });
    });
    renderFramed(modality, <p>held content</p>);
    expect(screen.getByTestId('node-upload-error')).toHaveTextContent('Upload failed.');
  });

  it('shows one skeleton on an empty node, in place of its call to action', () => {
    act(() => {
      marks().begin('', 'n1', 'upload');
    });
    renderFramed('image', <NodePlaceholder modality='image' />);
    expect(screen.getAllByTestId('node-upload-skeleton')).toHaveLength(1);
    expect(screen.getByTestId('node-placeholder')).toContainElement(screen.getByTestId('node-upload-skeleton'));
  });

  it('shows one error line on an empty node', () => {
    act(() => {
      const op = marks().begin('', 'n1', 'upload');
      marks().fail('', 'n1', op, { key: 'canvas.upload.failed' });
    });
    renderFramed('image', <NodePlaceholder modality='image' />);
    expect(screen.getAllByTestId('node-upload-error')).toHaveLength(1);
  });

  it('shows the content alone without a mark', () => {
    renderFramed('audio', <p>held content</p>);
    expect(screen.queryByTestId('node-upload-skeleton')).toBeNull();
    expect(screen.queryByTestId('node-upload-error')).toBeNull();
  });
});
