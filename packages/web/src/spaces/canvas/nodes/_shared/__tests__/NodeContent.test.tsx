// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PLANNED_BODY_MIN_PX } from '@web/spaces/canvas/group-geometry';
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

  // inner#1303 §6.7: a node built for a result whose size is known holds that
  // place empty, as tall as the picture will draw at the node's width.
  it('holds the planned picture’s shape, inset like a picture, when the node knows its size', () => {
    render(
      <NodeContent
        hasContent={false}
        emptySize={{ width: 1600, height: 400 }}
        placeholder={<div data-testid='ph'>P</div>}
        content={<div>C</div>}
      />,
    );
    const empty = screen.getByTestId('node-content-empty');
    expect(empty.className).not.toContain('h-48');
    expect(empty.closest('[data-testid="node-media-inset"]')).not.toBeNull();
    expect(empty.style.aspectRatio).toBe('1600 / 400');
    // Never shorter than what the placeholder needs, which layout reserves too.
    expect(empty.style.minHeight).toBe(`${PLANNED_BODY_MIN_PX}px`);
    expect(empty).not.toHaveClass('overflow-hidden');
    // An auto width would take the minimum height through the ratio and widen.
    expect(empty).toHaveClass('w-full');
    expect(screen.getByTestId('ph')).toBeInTheDocument();
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
