// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { PREVIEW_WIDTH } from '@breatic/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  NodeZoomedPastPreviewContext,
  useZoomedPastPreview,
  zoomedPastPreview,
} from '@web/spaces/canvas/nodes/_shared/preview-zoom';

describe('zoomedPastPreview', () => {
  it('keeps the preview while the node covers at most 576 device pixels', () => {
    expect(zoomedPastPreview(288, 1, 2, PREVIEW_WIDTH)).toBe(false);
    expect(zoomedPastPreview(288, 2, 1, PREVIEW_WIDTH)).toBe(false);
  });

  it('asks for the original once the node covers more than 576 device pixels', () => {
    expect(zoomedPastPreview(288, 1.01, 2, PREVIEW_WIDTH)).toBe(true);
    expect(zoomedPastPreview(288, 2.5, 1, PREVIEW_WIDTH)).toBe(true);
  });

  it('measures against a narrower preview when the picture has one', () => {
    // A 1080x64800 strip gets a 273-wide preview: at 100% on a 2x screen the
    // node already stretches it.
    expect(zoomedPastPreview(288, 1, 2, 273)).toBe(true);
    expect(zoomedPastPreview(288, 0.4, 2, 273)).toBe(false);
  });

  it('says nothing about a node it has no width for', () => {
    expect(zoomedPastPreview(0, 8, 2, PREVIEW_WIDTH)).toBe(false);
  });
});

/**
 * Shows what the hook answers.
 * @param props - The probe's props.
 * @param props.image - The image the node shows.
 * @returns The probe.
 */
function Probe({ image = 'a' }: { image?: string }): React.JSX.Element {
  return <span data-testid='probe'>{String(useZoomedPastPreview(image))}</span>;
}

/**
 * Render the probe under a given context value.
 * @param past - The value the canvas provides.
 * @param image - The image the node shows.
 * @returns The element tree.
 */
function tree(past: boolean, image = 'a'): React.JSX.Element {
  return (
    <NodeZoomedPastPreviewContext.Provider value={past}>
      <Probe image={image} />
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

  it('starts over for a new image in the same node', () => {
    const { rerender } = render(tree(true, 'a'));
    rerender(tree(false, 'a'));
    rerender(tree(false, 'b'));

    expect(screen.getByTestId('probe')).toHaveTextContent('false');
  });
});
