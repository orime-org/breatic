// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

  it('error state fills the same fixed h-48 box as empty/handling, not a collapsed one-line bar (#1632)', () => {
    render(
      <NodeContent
        status='error'
        errorMessage='Operation timed out'
        hasContent={false}
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );
    // Bug #1632: the error branch used h-full → height collapsed to one text
    // line (~42px), so the node became a flat wide bar instead of the empty
    // node's 288×192 box. It must fill the shared fixed h-48 like empty +
    // handling do, and NOT keep the collapsing h-full.
    const box = screen.getByTestId('node-content-error');
    expect(box.className).toContain('h-48');
    expect(box.className).not.toMatch(/\bh-full\b/);
  });

  it('says a task failed when the node carries no message of its own', () => {
    // A task's own reason is a row in the task list, in the reader's own
    // language. What the node says is this one sentence (#186 §3.7.2).
    render(
      <NodeContent
        status='error'
        hasContent={false}
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('node-content-error')).toHaveTextContent(
      /a task on this node failed/i,
    );
  });

  it('opens the task list from the error box', () => {
    // The detail is one click away, where it belongs: which task, who started
    // it, and why it failed.
    const onViewTasks = vi.fn();
    render(
      <NodeContent
        status='error'
        hasContent={false}
        placeholder={<div>P</div>}
        content={<div>C</div>}
        onViewTasks={onViewTasks}
      />,
    );

    fireEvent.click(screen.getByTestId('node-content-view-tasks'));
    expect(onViewTasks).toHaveBeenCalledOnce();
  });

  it('offers nothing to open when the failure never reached the task table', () => {
    // Text extracted in the browser is the one failure that stays local
    // (§3.7.4): it has no row, so there is no list to open.
    render(
      <NodeContent
        status='error'
        errorMessage='Extraction failed: a.bin'
        hasContent={false}
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );

    expect(screen.getByTestId('node-content-error')).toHaveTextContent(
      'Extraction failed: a.bin',
    );
    expect(
      screen.queryByTestId('node-content-view-tasks'),
    ).not.toBeInTheDocument();
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

  it('the handling skeleton fills the h-48 box to its edges, no inset padding (#2)', () => {
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
    // The skeleton must reach the node body's edges — the old `p-2` left an 8px
    // ring of empty card around it, which read as "skeleton doesn't fill the
    // node" (#2). No inset padding on the box.
    expect(box.className).not.toMatch(/\bp-2\b/);
    expect(
      box.querySelector('[data-testid="node-content-skeleton"]')?.className,
    ).toContain('h-full');
  });
});
