import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { NodeShell } from '../NodeShell';

describe('NodeShell', () => {
  it('renders children', () => {
    render(
      <NodeShell>
        <div>inside</div>
      </NodeShell>,
    );
    expect(screen.getByText('inside')).toBeInTheDocument();
  });

  it('idle status leaves no status ring', () => {
    render(<NodeShell status='idle'>x</NodeShell>);
    const shell = screen.getByTestId('node-shell');
    expect(shell.className).not.toMatch(/ring-status-/);
  });

  it('handling status applies the info ring', () => {
    render(<NodeShell status='handling'>x</NodeShell>);
    expect(screen.getByTestId('node-shell').className).toMatch(
      /ring-status-info/,
    );
  });

  it('error status applies the error ring (when not selected)', () => {
    render(<NodeShell status='error'>x</NodeShell>);
    expect(screen.getByTestId('node-shell').className).toMatch(
      /ring-status-error/,
    );
  });

  it('selected overrides status ring with primary ring', () => {
    render(
      <NodeShell selected status='error'>
        x
      </NodeShell>,
    );
    const cls = screen.getByTestId('node-shell').className;
    expect(cls).toMatch(/ring-primary/);
    expect(cls).not.toMatch(/ring-status-error/);
  });

  it('locked exposes a lock indicator', () => {
    render(<NodeShell locked>x</NodeShell>);
    expect(screen.getByTestId('node-lock-indicator')).toBeInTheDocument();
  });
});
