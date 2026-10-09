// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { WebNode } from '@web/spaces/canvas/nodes/WebNode';

describe('WebNode', () => {
  it('renders placeholder when no url', () => {
    render(<WebNode data={{ kind: 'web', handling: false }} />);
    expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
  });

  it('renders a sandboxed iframe with the url when present', () => {
    render(
      <WebNode
        data={{
          kind: 'web',
          content: 'https://example.com',
          handling: false,
        }}
      />,
    );
    const f = screen.getByTestId('web-node-iframe') as HTMLIFrameElement;
    expect(f.getAttribute('src')).toBe('https://example.com');
    expect(f.getAttribute('sandbox')).toContain('allow-scripts');
    expect(f.getAttribute('sandbox')).toContain('allow-same-origin');
  });

  // #1772: an eager iframe loads a FULL web page per node during the initial
  // all-nodes mount (xyflow #3883) — the heaviest media on the canvas. Native
  // lazy loading defers offscreen embeds to viewport proximity.
  it('the iframe is viewport-lazy (#1772)', () => {
    render(
      <WebNode
        data={{
          kind: 'web',
          content: 'https://example.com',
          handling: false,
        }}
      />,
    );
    expect(
      screen.getByTestId('web-node-iframe').getAttribute('loading'),
    ).toBe('lazy');
  });

});
