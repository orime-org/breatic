// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AnnotationNode } from '@web/spaces/canvas/nodes/AnnotationNode';

describe('AnnotationNode', () => {
  it('renders the message text', () => {
    render(
      <AnnotationNode
        data={{
          kind: 'annotation',
          text: 'Please center this',
          authorId: 'user-1',
          createdAt: new Date().toISOString(),
        }}
      />,
    );
    expect(screen.getByTestId('annotation-node-text')).toHaveTextContent(
      'Please center this',
    );
  });

  it('mounts the annotation shell at the standalone width', () => {
    render(
      <AnnotationNode
        data={{
          kind: 'annotation',
          text: 'x',
          authorId: 'u',
          createdAt: new Date().toISOString(),
        }}
      />,
    );
    expect(screen.getByTestId('annotation-node').className).toContain(
      'w-[200px]',
    );
  });

  it('shows initial as author avatar fallback', () => {
    render(
      <AnnotationNode
        data={{
          kind: 'annotation',
          text: 'x',
          authorId: 'alice',
          createdAt: new Date().toISOString(),
        }}
      />,
    );
    expect(screen.getByText('A')).toBeInTheDocument();
  });
});
