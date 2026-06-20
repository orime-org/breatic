// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeScaleContext } from '@web/spaces/canvas/nodes/_shared/node-scale';

describe('ContentNodeFrame', () => {
  it('floats the name header in an absolute anchor above the card', () => {
    render(
      <ContentNodeFrame modality='text' name='A' testId='text-node'>
        <div>body</div>
      </ContentNodeFrame>,
    );
    const anchor = screen.getByTestId('node-header-anchor');
    // Absolute so the header leaves the flow: the frame's in-flow box becomes
    // the card alone, which is what centres the Left/Right handles on the card
    // body rather than the header+card stack.
    expect(anchor.className).toContain('absolute');
    // #2: the gap between the name header and the card below is 4px (pb-1).
    expect(anchor.className).toContain('pb-1');
    expect(anchor).toContainElement(screen.getByTestId('node-header'));
    expect(screen.getByTestId('text-node')).toBeInTheDocument();
  });

  it('counter-scales the header by the canvas zoom from context', () => {
    render(
      <NodeScaleContext.Provider value={0.5}>
        <ContentNodeFrame modality='text' name='A' testId='text-node'>
          <div>body</div>
        </ContentNodeFrame>
      </NodeScaleContext.Provider>,
    );
    expect(screen.getByTestId('node-header-anchor').style.transform).toContain(
      'scale(0.5)',
    );
  });

  it('defaults to no counter-scale outside the canvas (scale 1)', () => {
    render(
      <ContentNodeFrame modality='text' name='A' testId='text-node'>
        <div>body</div>
      </ContentNodeFrame>,
    );
    expect(screen.getByTestId('node-header-anchor').style.transform).toContain(
      'scale(1)',
    );
  });

  it('a locked node name is still editable (lock does not lock rename)', () => {
    render(
      <ContentNodeFrame
        modality='text'
        name='Old'
        locked
        onRename={() => undefined}
        testId='text-node'
      >
        <div>body</div>
      </ContentNodeFrame>,
    );
    // Lock only restricts move / delete; the name is metadata and stays
    // editable — double-click the name must enter inline edit mode.
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    expect(screen.getByTestId('node-header-input')).toBeInTheDocument();
  });

  it('defaults the shell to the unified w-72 content-node width', () => {
    // Every content node shares one width (set here, not per-node) so the
    // canvas reads as a uniform grid. Per-node `w-XX` overrides are removed.
    render(
      <ContentNodeFrame modality='text' name='A' testId='text-node'>
        <div>body</div>
      </ContentNodeFrame>,
    );
    expect(screen.getByTestId('text-node').className).toContain('w-72');
  });
});
