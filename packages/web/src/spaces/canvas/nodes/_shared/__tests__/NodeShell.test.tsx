// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';

describe('NodeShell', () => {
  it('renders children', () => {
    render(
      <NodeShell>
        <div>inside</div>
      </NodeShell>,
    );
    expect(screen.getByText('inside')).toBeInTheDocument();
  });

  it('idle tints the node with the neutral 1px border (no status color, no ring)', () => {
    render(<NodeShell status='idle'>x</NodeShell>);
    const cls = screen.getByTestId('node-shell').className;
    expect(cls).toMatch(/border-border/);
    expect(cls).not.toMatch(/border-status-/);
    expect(cls).not.toMatch(/ring-/);
  });

  it('handling tints the 1px border with the info status (no ring / offset glow)', () => {
    render(<NodeShell status='handling'>x</NodeShell>);
    const cls = screen.getByTestId('node-shell').className;
    expect(cls).toMatch(/border-status-info/);
    expect(cls).not.toMatch(/ring-/);
  });

  it('error tints the 1px border with the error status (when not selected)', () => {
    render(<NodeShell status='error'>x</NodeShell>);
    const cls = screen.getByTestId('node-shell').className;
    expect(cls).toMatch(/border-status-error/);
    expect(cls).not.toMatch(/ring-/);
  });

  it('selected tints its own 1px border with the selected status, overriding any status border, no ring or offset glow', () => {
    render(
      <NodeShell selected status='error'>
        x
      </NodeShell>,
    );
    const cls = screen.getByTestId('node-shell').className;
    expect(cls).toMatch(/border-status-selected/);
    expect(cls).not.toMatch(/border-status-error/);
    expect(cls).not.toMatch(/ring-/);
  });

  it('locked exposes a lock indicator', () => {
    render(<NodeShell locked>x</NodeShell>);
    expect(screen.getByTestId('node-lock-indicator')).toBeInTheDocument();
  });
});

/**
 * NodeShell visual contract — aligns the canvas node card with the 9th-slice
 * design system (6px radius, static-card-zero-shadow, hover = border only,
 * lock icon). The drag-lift shadow itself is a ReactFlow-`.dragging` CSS rule
 * (browser-verified); these unit tests pin the class-level invariants.
 */
describe('NodeShell visual contract', () => {
  it('uses the 6px small radius, not the 16px large radius', () => {
    render(
      <NodeShell>
        <div />
      </NodeShell>,
    );
    const shell = screen.getByTestId('node-shell');
    expect(shell.className).toContain('rounded-sm');
    expect(shell.className).not.toContain('rounded-lg');
  });

  it('carries no static shadow; exposes the drag-lift CSS hook class', () => {
    render(
      <NodeShell>
        <div />
      </NodeShell>,
    );
    const shell = screen.getByTestId('node-shell');
    // A static node is flat (design system: only a DRAGGING node lifts).
    expect(shell.className).not.toContain('shadow-sm');
    // Stable hook the `.react-flow__node.dragging .canvas-node-shell` rule targets.
    expect(shell.className).toContain('canvas-node-shell');
  });

  it('an idle node hovers its BORDER, never its background', () => {
    render(
      <NodeShell status='idle'>
        <div />
      </NodeShell>,
    );
    const shell = screen.getByTestId('node-shell');
    expect(shell.className).toContain('hover:border-foreground-disabled');
    expect(shell.className).not.toContain('hover:bg-');
  });

  it('a selected node keeps its selected border with NO hover override', () => {
    render(
      <NodeShell selected>
        <div />
      </NodeShell>,
    );
    const shell = screen.getByTestId('node-shell');
    expect(shell.className).toContain('border-status-selected');
    expect(shell.className).not.toContain('hover:border');
  });

  it('renders a lock ICON (not the literal word) when locked', () => {
    render(
      <NodeShell locked>
        <div />
      </NodeShell>,
    );
    const indicator = screen.getByTestId('node-lock-indicator');
    expect(indicator.querySelector('svg')).toBeTruthy();
    expect(indicator.textContent).not.toContain('lock');
  });
});
