// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The moment a buyer comes back from Stripe (task #13 §4.4).
 *
 * Coming back is a full page reload, so the overlay's in-component open flag
 * is always false by then. Landing has to be driven by the parameters on the
 * address; nothing left in the page can be relied on.
 *
 * Both routes back are derived from the same `return_url` and land on the same
 * route, told apart only by their parameters: a paid checkout carries
 * `session_id`, a pressed Back button carries `cancelled` and `payment_id`.
 * Confusing the two means calling the confirm endpoint with an abandoned
 * checkout, and the abandon path never runs at all.
 *
 * The waiting layer has an exit that does not depend on an answer: on timeout
 * it is torn down anyway and still lands on the purchase history, where that
 * purchase reads as pending. The buyer is never stuck behind a spinner that
 * never resolves.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useCheckoutReturn } from '@web/features/credits/use-checkout-return';

const confirm = vi.fn();
const cancel = vi.fn();
vi.mock('@web/data/api/payment', () => ({
  paymentApi: {
    confirm: (...args: unknown[]) => confirm(...args),
    cancel: (...args: unknown[]) => cancel(...args),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  confirm.mockResolvedValue({ status: 'granted' });
  cancel.mockResolvedValue({ status: 'expired' });
});

afterEach(() => {
  vi.useRealTimers();
});

/** What the hook reported on its last render. */
interface Seen {
  waiting: boolean;
  open: boolean;
  section: string | null;
  search: string;
}

let seen: Seen;

/**
 * A probe that renders whatever the hook says.
 * @returns Nothing visible; the state is read from `seen`.
 */
function Probe(): React.JSX.Element {
  const state = useCheckoutReturn({ confirmTimeoutMs: 50 });
  seen = {
    waiting: state.waiting,
    open: state.overlayOpen,
    section: state.initialSection,
    search: window.location.search,
  };
  return <div data-testid='probe' />;
}

/**
 * Mount the probe on one address.
 * @param search - The query string, with its leading `?`.
 * @returns The render result.
 */
function mountAt(search: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/s/mine${search}`]}>
      <Probe />
    </MemoryRouter>,
  );
}

describe('coming back from a payment', () => {
  it('covers the page while the purchase is being settled', async () => {
    let settle: (value: { status: string }) => void = () => {};
    confirm.mockReturnValue(
      new Promise<{ status: string }>((resolve) => {
        settle = resolve;
      }),
    );
    mountAt('?credits=1&session_id=cs_test_1');

    await waitFor(() => {
      expect(seen.waiting).toBe(true);
    });
    expect(confirm).toHaveBeenCalledWith('cs_test_1');

    settle({ status: 'granted' });
    await waitFor(() => {
      expect(seen.waiting).toBe(false);
    });
  });

  it('lands on the purchase history with the overlay open', async () => {
    mountAt('?credits=1&session_id=cs_test_1');
    await waitFor(() => {
      expect(seen.waiting).toBe(false);
    });
    expect(seen.open).toBe(true);
    expect(seen.section).toBe('lots');
  });

  it('lands there even when settling failed', async () => {
    confirm.mockRejectedValue(new Error('offline'));
    mountAt('?credits=1&session_id=cs_test_1');

    // The purchase is unharmed: the webhook and reconciling both settle it,
    // and the history is where its state is read.
    await waitFor(() => {
      expect(seen.waiting).toBe(false);
    });
    expect(seen.section).toBe('lots');
  });

  it('stops waiting on its own when the answer does not come', async () => {
    confirm.mockReturnValue(new Promise(() => {}));
    mountAt('?credits=1&session_id=cs_test_1');

    await waitFor(
      () => {
        expect(seen.waiting).toBe(false);
      },
      { timeout: 2000 },
    );
    expect(seen.section).toBe('lots');
  });
});

describe('coming back from the Back button', () => {
  it('abandons that purchase and opens on the buy screen', async () => {
    mountAt('?credits=1&cancelled=1&payment_id=9f1c7c2e-0000-4000-8000-000000000001');

    await waitFor(() => {
      expect(cancel).toHaveBeenCalledWith(
        '9f1c7c2e-0000-4000-8000-000000000001',
      );
    });
    expect(seen.section).toBe('buy');
  });

  it('covers nothing: there is no answer worth waiting for', async () => {
    mountAt('?credits=1&cancelled=1&payment_id=p1');
    await waitFor(() => {
      expect(cancel).toHaveBeenCalled();
    });
    expect(seen.waiting).toBe(false);
  });

  it('never mistakes an abandoned checkout for a paid one', async () => {
    mountAt('?credits=1&cancelled=1&payment_id=p1');
    await waitFor(() => {
      expect(cancel).toHaveBeenCalled();
    });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('the address afterwards', () => {
  it('drops the parameters so a reload does not replay the return', async () => {
    mountAt('?credits=1&session_id=cs_test_1');
    await waitFor(() => {
      expect(seen.waiting).toBe(false);
    });
    await waitFor(() => {
      expect(seen.search).not.toContain('session_id');
    });
    expect(seen.search).not.toContain('credits=1');
  });

  it('settles one return once, however many times it renders', async () => {
    const view = mountAt('?credits=1&session_id=cs_test_1');
    await waitFor(() => {
      expect(seen.waiting).toBe(false);
    });
    view.rerender(
      <MemoryRouter initialEntries={['/s/mine?credits=1&session_id=cs_test_1']}>
        <Probe />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(1);
    });
  });
});

describe('an ordinary page load', () => {
  it('does nothing at all without the parameters', async () => {
    mountAt('');
    await waitFor(() => {
      expect(screen.getByTestId('probe')).toBeInTheDocument();
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(seen.open).toBe(false);
    expect(seen.waiting).toBe(false);
  });

  it('opens the overlay without settling anything when only asked to', async () => {
    mountAt('?credits=1');
    await waitFor(() => {
      expect(seen.open).toBe(true);
    });
    expect(seen.section).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
