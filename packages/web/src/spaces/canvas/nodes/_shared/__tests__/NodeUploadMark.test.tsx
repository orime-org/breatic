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
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
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

  // A failure names the file, and a long name has no space to break at.
  it('breaks a long unspaced name in the failure line anywhere', () => {
    act(() => {
      const op = marks().begin('', 'n1', 'upload');
      marks().fail('', 'n1', op, { text: `${'a'.repeat(80)}.png is not a picture we take.` });
    });
    render(<NodePlaceholder modality='image' />);
    expect(screen.getByTestId('node-upload-error')).toHaveClass('wrap-anywhere');
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
 * Render a node the way every content node does: its frame around
 * `NodeContent`, showing the body, or the placeholder when it holds nothing.
 * @param body - What the node shows, or null for an empty node.
 */
function renderFramed(body: React.ReactNode): void {
  render(
    <ReactFlowProvider>
      <ContentNodeFrame modality='image'>
        <NodeContent hasContent={body !== null} placeholder={<NodePlaceholder modality='image' />} content={body} />
      </ContentNodeFrame>
    </ReactFlowProvider>,
  );
}

describe('NodeContent with an upload mark', () => {
  it('lays a skeleton over what the node shows', () => {
    act(() => {
      marks().begin('', 'n1', 'upload');
    });
    renderFramed(<p>held content</p>);
    expect(screen.getAllByTestId('node-upload-skeleton')).toHaveLength(1);
  });

  it('says what went wrong over what the node shows', () => {
    act(() => {
      const op = marks().begin('', 'n1', 'upload');
      marks().fail('', 'n1', op, { key: 'canvas.upload.failed' });
    });
    renderFramed(<p>held content</p>);
    expect(screen.getByTestId('node-upload-error')).toHaveTextContent('Upload failed.');
  });

  // The line sits along the node's bottom edge, where a player's controls are:
  // it says what happened and leaves the controls under it working.
  it('lets presses through the line over what the node shows', () => {
    act(() => {
      const op = marks().begin('', 'n1', 'upload');
      marks().fail('', 'n1', op, { key: 'canvas.upload.failed' });
    });
    renderFramed(<p>held content</p>);
    expect(screen.getByTestId('node-upload-error')).toHaveClass('pointer-events-none');
  });

  it('breaks a long unspaced name in the line over what the node shows anywhere', () => {
    act(() => {
      const op = marks().begin('', 'n1', 'upload');
      marks().fail('', 'n1', op, { text: `${'a'.repeat(80)}.png is not a picture we take.` });
    });
    renderFramed(<p>held content</p>);
    expect(screen.getByTestId('node-upload-error')).toHaveClass('wrap-anywhere');
  });

  it('shows one skeleton on an empty node, in place of its call to action', () => {
    act(() => {
      marks().begin('', 'n1', 'upload');
    });
    renderFramed(null);
    expect(screen.getAllByTestId('node-upload-skeleton')).toHaveLength(1);
    expect(screen.getByTestId('node-placeholder')).toContainElement(screen.getByTestId('node-upload-skeleton'));
  });

  it('shows one error line on an empty node', () => {
    act(() => {
      const op = marks().begin('', 'n1', 'upload');
      marks().fail('', 'n1', op, { key: 'canvas.upload.failed' });
    });
    renderFramed(null);
    expect(screen.getAllByTestId('node-upload-error')).toHaveLength(1);
  });

  it('shows the content alone without a mark', () => {
    renderFramed(<p>held content</p>);
    expect(screen.queryByTestId('node-upload-skeleton')).toBeNull();
    expect(screen.queryByTestId('node-upload-error')).toBeNull();
  });
});
