// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { setLocale } from '@breatic/shared';

import { AnnotationNode } from '@web/spaces/canvas/nodes/AnnotationNode';

describe('AnnotationNode', () => {
  it('renders the message text', () => {
    render(
      <AnnotationNode
        data={{
          kind: 'annotation',
          content: 'Please center this',
          createdBy: 'user-1',
          createdAt: Date.now(),
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
          content: 'x',
          createdBy: 'u',
          createdAt: Date.now(),
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
          content: 'x',
          createdBy: 'alice',
          createdAt: Date.now(),
        }}
      />,
    );
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('says when in the language the reader chose', () => {
    // The sticky used to carry its own formatter, which said "5m ago" in every
    // language (#2155). It reads the shared one now, so the switch reaches it.
    const posted = Date.now() - 5 * 60_000;
    const { unmount } = render(
      <AnnotationNode
        data={{
          kind: 'annotation',
          content: 'x',
          createdBy: 'u',
          createdAt: posted,
        }}
      />,
    );
    expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
    unmount();

    setLocale('zh-CN');
    render(
      <AnnotationNode
        data={{
          kind: 'annotation',
          content: 'x',
          createdBy: 'u',
          createdAt: posted,
        }}
      />,
    );
    expect(screen.queryByText('5 minutes ago')).not.toBeInTheDocument();
    expect(screen.getByText('5 分钟前')).toBeInTheDocument();
  });

  afterEach(() => {
    setLocale('en');
  });
});
