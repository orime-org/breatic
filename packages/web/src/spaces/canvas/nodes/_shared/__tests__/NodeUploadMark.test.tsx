// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a node shows for the uploader's own mark (inner#1303 §6.7): a
 * skeleton while it waits for the server's answer, and a line saying what
 * went wrong when it ended before that. Nodes without a mark look as before.
 */

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', async (original) => ({ ...(await original<object>()), useNodeId: () => 'n1' }));

import { NodeMediaInset } from '@web/spaces/canvas/nodes/_shared/NodeMediaInset';
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
      marks().begin('', 'n1');
    });
    render(<NodePlaceholder modality='image' />);
    expect(screen.getByTestId('node-upload-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/double-click to upload/i)).toBeNull();
  });

  it('says what went wrong when it failed before the answer', () => {
    act(() => {
      const op = marks().begin('', 'n1');
      marks().fail('', 'n1', op, { key: 'canvas.upload.failed' });
    });
    render(<NodePlaceholder modality='image' />);
    expect(screen.getByTestId('node-upload-error')).toHaveTextContent('Upload failed.');
  });

  it('goes back to the call to action once answered', () => {
    let op = '';
    act(() => {
      op = marks().begin('', 'n1');
    });
    render(<NodePlaceholder modality='image' />);
    act(() => marks().answer('', 'n1', op));
    expect(screen.queryByTestId('node-upload-skeleton')).toBeNull();
    expect(screen.getByText(/double-click to upload/i)).toBeInTheDocument();
  });
});

describe('a node with content and an upload mark', () => {
  it('lays a skeleton over the media while it waits', () => {
    act(() => {
      marks().begin('', 'n1');
    });
    render(
      <NodeMediaInset>
        <img alt='' src='a.png' />
      </NodeMediaInset>,
    );
    expect(screen.getByTestId('node-upload-skeleton')).toBeInTheDocument();
  });

  it('says what went wrong along the media when it failed', () => {
    act(() => {
      const op = marks().begin('', 'n1');
      marks().fail('', 'n1', op, { key: 'canvas.upload.failed' });
    });
    render(
      <NodeMediaInset>
        <img alt='' src='a.png' />
      </NodeMediaInset>,
    );
    expect(screen.getByTestId('node-upload-error')).toHaveTextContent('Upload failed.');
  });

  it('shows the media alone without a mark', () => {
    render(
      <NodeMediaInset>
        <img alt='' src='a.png' />
      </NodeMediaInset>,
    );
    expect(screen.queryByTestId('node-upload-skeleton')).toBeNull();
    expect(screen.queryByTestId('node-upload-error')).toBeNull();
  });
});
