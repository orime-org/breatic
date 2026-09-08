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

  it('shows what the node holds while a task runs on it', () => {
    // The counts beside the node say something is working. Covering the
    // content took away the thing the reader came for (user 2026-09-06).
    render(
      <NodeContent
        status='handling'
        hasContent
        placeholder={<div>P</div>}
        content={<div data-testid='content'>C</div>}
      />,
    );
    expect(screen.getByTestId('content')).toBeInTheDocument();
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

  it('says a task did not finish when the node carries no message of its own', () => {
    // A task's own reason is a row in the task list, in the reader's own
    // language. What the node says is this one sentence (#186 §3.7.2), and
    // `error` is entered by a failed task or an expired one alike
    // (`deriveStatus`), so the sentence has to hold for both — naming failure
    // puts the word "failed" on a node whose panel is headed "Expired".
    render(
      <NodeContent
        status='error'
        hasContent={false}
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );
    const box = screen.getByTestId('node-content-error');
    expect(box).toHaveTextContent(/did not finish/i);
    expect(box).not.toHaveTextContent(/failed/i);
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

  it('holds its empty box while a task runs on a node with nothing in it', () => {
    // An empty node keeps the 288x192 footprint it had, so a task starting on
    // it moves nothing on the board.
    render(
      <NodeContent
        status='handling'
        hasContent={false}
        placeholder={<div>P</div>}
        content={<div>C</div>}
      />,
    );
    expect(screen.getByTestId('node-content-empty').className).toContain('h-48');
  });
});
