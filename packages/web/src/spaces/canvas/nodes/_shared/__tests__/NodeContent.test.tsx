// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';

describe('NodeContent', () => {
  it('renders the placeholder in a fixed h-48 box when the node holds nothing', () => {
    render(
      <NodeContent
        hasContent={false}
        placeholder={<div data-testid='ph'>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('ph')).toBeInTheDocument();
    expect(screen.getByTestId('node-content-empty').className).toContain('h-48');
  });

  it('renders the content when the node holds something', () => {
    render(
      <NodeContent
        hasContent
        placeholder={<div>P</div>}
        content={<div data-testid='content'>C</div>}
      />,
    );
    expect(screen.getByTestId('content')).toBeInTheDocument();
    expect(screen.queryByTestId('node-content-empty')).toBeNull();
  });
});
