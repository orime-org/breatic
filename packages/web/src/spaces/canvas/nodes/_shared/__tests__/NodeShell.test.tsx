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
