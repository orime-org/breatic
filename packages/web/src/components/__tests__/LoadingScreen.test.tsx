// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { render, screen } from '@testing-library/react';

import { LoadingScreen, LoadingScreenHost } from '@web/components/LoadingScreen';

// Two waits that sit at different places in the tree, the way the auth gate,
// the route boundary and the project page do.
function GateWait(): React.JSX.Element {
  return (
    <section>
      <LoadingScreen />
    </section>
  );
}

function PageWait(): React.JSX.Element {
  return (
    <main>
      <div>
        <LoadingScreen />
      </div>
    </main>
  );
}

function Stage({ step }: { step: 'gate' | 'page' | 'done' }): React.JSX.Element {
  return (
    <>
      {step === 'gate' && <GateWait />}
      {step === 'page' && <PageWait />}
      {step === 'done' && <p data-testid='page'>page</p>}
      <LoadingScreenHost />
    </>
  );
}

describe('LoadingScreen', () => {
  it('keeps the same screen on display when one wait hands over to the next', () => {
    const { rerender } = render(<Stage step='gate' />);
    const first = screen.getByTestId('loading-screen');

    rerender(<Stage step='page' />);

    expect(screen.getByTestId('loading-screen')).toBe(first);
  });

  it('shows one screen however many waits are open at once', () => {
    render(
      <>
        <GateWait />
        <PageWait />
        <LoadingScreenHost />
      </>,
    );

    expect(screen.getAllByTestId('loading-screen')).toHaveLength(1);
  });

  it('leaves once the last wait is over', () => {
    const { rerender } = render(<Stage step='page' />);

    rerender(<Stage step='done' />);

    expect(screen.queryByTestId('loading-screen')).toBeNull();
    expect(screen.getByTestId('page')).toBeInTheDocument();
  });

  it('covers the viewport with a spinner and the loading text', () => {
    render(<Stage step='gate' />);

    const shown = screen.getByTestId('loading-screen');
    expect(shown).toHaveAttribute('role', 'status');
    expect(shown.className).toContain('fixed');
    expect(shown.className).toContain('inset-0');
    expect(shown.querySelector('.animate-spin')).not.toBeNull();
    expect(shown).toHaveTextContent(/\S/);
  });
});
