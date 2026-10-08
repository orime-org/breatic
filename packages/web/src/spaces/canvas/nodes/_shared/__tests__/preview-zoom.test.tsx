// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  NodeZoomedPastPreviewContext,
  useZoomedPastPreview,
  zoomedPastPreview,
} from '@web/spaces/canvas/nodes/_shared/preview-zoom';

describe('zoomedPastPreview', () => {
  it('keeps the preview while the node covers at most 576 device pixels', () => {
    expect(zoomedPastPreview(288, 1, 2)).toBe(false);
    expect(zoomedPastPreview(288, 2, 1)).toBe(false);
  });

  it('asks for the original once the node covers more than 576 device pixels', () => {
    expect(zoomedPastPreview(288, 1.01, 2)).toBe(true);
    expect(zoomedPastPreview(288, 2.5, 1)).toBe(true);
  });

  it('says nothing about a node it has no width for', () => {
    expect(zoomedPastPreview(0, 8, 2)).toBe(false);
  });
});

/** Shows what the hook answers. */
function Probe(): React.JSX.Element {
  return <span data-testid='probe'>{String(useZoomedPastPreview())}</span>;
}

/**
 * Render the probe under a given context value.
 * @param past - The value the canvas provides.
 * @returns The element tree.
 */
function tree(past: boolean): React.JSX.Element {
  return (
    <NodeZoomedPastPreviewContext.Provider value={past}>
      <Probe />
    </NodeZoomedPastPreviewContext.Provider>
  );
}

describe('useZoomedPastPreview', () => {
  it('is false outside the canvas', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('false');
  });

  it('stays true after the canvas zooms back out', () => {
    const { rerender } = render(tree(false));
    expect(screen.getByTestId('probe')).toHaveTextContent('false');

    rerender(tree(true));
    expect(screen.getByTestId('probe')).toHaveTextContent('true');

    rerender(tree(false));
    expect(screen.getByTestId('probe')).toHaveTextContent('true');
  });
});
