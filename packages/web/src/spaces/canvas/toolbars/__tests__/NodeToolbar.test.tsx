// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { NodeToolbar } from '@web/spaces/canvas/toolbars/NodeToolbar';

describe('NodeToolbar', () => {
  it('renders both zones', () => {
    render(<NodeToolbar nodeId='n1' modality='image' />);
    expect(screen.getByTestId('node-toolbar-left')).toBeInTheDocument();
    expect(screen.getByTestId('node-toolbar-right')).toBeInTheDocument();
  });

  it('left zone exposes both Generate and Load triggers', () => {
    render(<NodeToolbar nodeId='n1' modality='text' />);
    expect(screen.getByTestId('node-generate-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('node-load-trigger')).toBeInTheDocument();
  });

  it('right zone exposes the Mini-tool trigger', () => {
    render(<NodeToolbar nodeId='n1' modality='video' />);
    expect(screen.getByTestId('mini-tool-trigger')).toBeInTheDocument();
  });

  it('visible=false makes the toolbar pointer-events-none + opacity 0', () => {
    render(<NodeToolbar nodeId='n1' modality='audio' visible={false} />);
    const t = screen.getByTestId('node-toolbar');
    expect(t.className).toContain('pointer-events-none');
    expect(t.className).toContain('opacity-0');
  });

  it('data-node-id is forwarded for e2e selectors', () => {
    render(<NodeToolbar nodeId='node-42' modality='image' />);
    expect(
      screen.getByTestId('node-toolbar').getAttribute('data-node-id'),
    ).toBe('node-42');
  });
});
