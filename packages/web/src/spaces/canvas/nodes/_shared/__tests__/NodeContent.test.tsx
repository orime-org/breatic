// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';

describe('NodeContent', () => {
  it('renders placeholder when status=idle + no content', () => {
    render(
      <NodeContent
        status='idle'
        hasContent={false}
        placeholder={<div data-testid='ph'>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('ph')).toBeInTheDocument();
  });

  it('renders content when status=idle + hasContent', () => {
    render(
      <NodeContent
        status='idle'
        hasContent
        placeholder={<div>P</div>}
        content={<div data-testid='content'>C</div>}
      />,
    );
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('renders skeleton when status=handling regardless of content', () => {
    render(
      <NodeContent
        status='handling'
        hasContent
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('node-content-handling')).toBeInTheDocument();
  });

  it('renders the error message when status=error', () => {
    render(
      <NodeContent
        status='error'
        errorMessage='Oh no'
        hasContent
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('node-content-error')).toHaveTextContent('Oh no');
  });

  it('error block falls back to a generic message when no errorMessage', () => {
    render(
      <NodeContent
        status='error'
        hasContent={false}
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('node-content-error')).toHaveTextContent(
      /something went wrong/i,
    );
  });

  it('the empty state fills a fixed h-48 box so every empty node is the same size', () => {
    render(
      <NodeContent
        status='idle'
        hasContent={false}
        placeholder={<div data-testid='ph'>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('node-content-empty').className).toContain('h-48');
  });

  it('the handling skeleton fills the fixed h-48 box, not a small centered bar', () => {
    render(
      <NodeContent
        status='handling'
        hasContent
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );
    const box = screen.getByTestId('node-content-handling');
    expect(box.className).toContain('h-48');
    expect(
      box.querySelector('[data-testid="node-content-skeleton"]')?.className,
    ).toContain('h-full');
  });
});
