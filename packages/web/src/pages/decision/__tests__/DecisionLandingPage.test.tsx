// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one page five flows are answered on.
 *
 * It replaces two invite pages that each had their own suite, so the cases they
 * covered have to survive here: the dead ends must each say their own thing,
 * the person who is not being asked must not get buttons, and a failed answer
 * must leave the card where it was.
 *
 * Two properties are specific to the merge and are the reason this file exists:
 *
 *   1. The copy is one ICU select on `kind`. A missing arm renders the
 *      fallback, which reads plausibly enough to ship unnoticed — so every kind
 *      is asserted against the words only its own arm produces.
 *   2. The bell used to do the refreshing after a decision, and its mutations
 *      were deleted with it. If this page forgets, the answered row sits in the
 *      inbox until a reload. Both query keys are asserted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DecisionKind, DecisionView } from '@breatic/shared';

import DecisionLandingPage from '@web/pages/decision/DecisionLandingPage';
import { ApiException } from '@web/data/api/types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

vi.mock('@web/data/api/decisions', () => ({
  decisionsApi: { view: vi.fn(), respond: vi.fn() },
}));

// Assert on the app's toast wrapper (public API), not sonner: the wrapper adds
// the de-dup id internally, so its methods still take just the message.
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { decisionsApi } from '@web/data/api/decisions';
import { toast } from '@web/lib/toast';

const TOKEN = 'tok-abc';

/** A studio invite waiting for an answer; override per test. */
function makeView(o: Partial<DecisionView> = {}): DecisionView {
  return {
    kind: 'studio_invite',
    state: 'answerable',
    entityName: 'Q1 Sprint',
    actorName: 'Ana',
    role: 'guest',
    message: null,
    expiresAt: null,
    isRecipient: true,
    windowDays: 7,
    destination: null,
    ...o,
  };
}

/**
 * Renders the page at a decision URL, with stub routes for the two places a
 * settled decision can send you and for the footer links.
 * @param initial - The entry URL to render at.
 * @returns The rendered page and the query client it was given.
 */
function setup(initial = `/decision?token=${TOKEN}`): {
  rendered: ReturnType<typeof render>;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path='/decision' element={<DecisionLandingPage />} />
          <Route path='/project/:projectId' element={<div>ProjectStub</div>} />
          <Route path='/studio/:slug' element={<div>StudioStub</div>} />
          <Route path='/studio' element={<div>RecentStub</div>} />
          <Route path='/login' element={<div>LoginStub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { rendered, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does NOT drain mockResolvedValueOnce queues — a test that
  // queues more responses than it consumes would poison its neighbours.
  vi.mocked(decisionsApi.view).mockReset();
  vi.mocked(decisionsApi.respond).mockReset();
});

describe('every kind gets its own words', () => {
  // The words each arm alone produces. A dropped arm falls through to the
  // `other` fallback, which is grammatical and would otherwise pass unnoticed.
  const KINDS: ReadonlyArray<readonly [DecisionKind, RegExp, Partial<DecisionView>]> = [
    ['studio_invite', /invited you to join Q1 Sprint as a Guest/i, { role: 'guest' }],
    ['project_invite', /invited you to work on Q1 Sprint as an Editor/i, { role: 'editor' }],
    ['role_upgrade', /asked to become Editor on Q1 Sprint/i, { role: 'editor' }],
    ['project_transfer', /wants to make you the Owner of Q1 Sprint/i, { role: null }],
    ['studio_transfer', /wants to make you the Admin of Q1 Sprint/i, { role: null }],
  ];

  it.each(KINDS)('%s says what it is', async (kind, sentence, extra) => {
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(
      makeView({ kind, ...extra }),
    );
    setup();
    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });

  it('names the role in Title Case, not the raw column value', async () => {
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(
      makeView({ kind: 'role_upgrade', role: 'editor' }),
    );
    setup();
    await screen.findByRole('button', { name: 'Approve' });
    // `editor` is what the database calls it; `Editor` is what the product
    // calls it everywhere else (the frozen product-term catalog).
    expect(screen.queryByText(/become editor on/)).toBeNull();
  });

  it('a role upgrade shows the words the requester typed', async () => {
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(
      makeView({ kind: 'role_upgrade', message: 'I keep needing edit access' }),
    );
    setup();
    expect(
      await screen.findByText(/I keep needing edit access/i),
    ).toBeInTheDocument();
  });

  it('a role upgrade is approved, not accepted', async () => {
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(
      makeView({ kind: 'role_upgrade' }),
    );
    setup();
    expect(
      await screen.findByRole('button', { name: 'Approve' }),
    ).toBeInTheDocument();
  });
});

describe('the dead ends each say their own thing', () => {
  // Before this page they all read "invalid link", which was true of exactly
  // one of them.
  const ENDS: ReadonlyArray<readonly [DecisionView['state'], RegExp]> = [
    ['accepted', /already accepted/i],
    ['declined', /already declined/i],
    ['expired', /request has ended/i],
    ['revoked', /was withdrawn/i],
    ['gone', /no longer here/i],
    ['already_member', /already in/i],
  ];

  it.each(ENDS)('%s does not read as an invalid link', async (state, words) => {
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(makeView({ state }));
    setup();
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('the expired card says how long the window was', async () => {
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(
      makeView({ state: 'expired', windowDays: 7 }),
    );
    setup();
    // No date — the reaper does not run on the instant, so printing one lies.
    // How long you HAD is what answers "why can't I answer this any more".
    expect(await screen.findByText(/within 7 days/i)).toBeInTheDocument();
  });

  it('already-a-member offers the way in, since there is one', async () => {
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(
      makeView({ state: 'already_member', destination: '/studio/q1-sprint' }),
    );
    setup();
    const link = await screen.findByRole('link', { name: 'Go there' });
    expect(link).toHaveAttribute('href', '/studio/q1-sprint');
  });

  it('offers no way in when the server named nowhere', async () => {
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(
      makeView({ state: 'already_member', destination: null }),
    );
    setup();
    await screen.findByText(/already in/i);
    expect(screen.queryByRole('link', { name: 'Go there' })).toBeNull();
  });

  it('a token nobody issued is the one case that IS an invalid link', async () => {
    vi.mocked(decisionsApi.view).mockRejectedValueOnce(
      new ApiException({ status: 404, code: 'NOT_FOUND', message: 'gone' }),
    );
    setup();
    expect(await screen.findByText(/link is not valid/i)).toBeInTheDocument();
  });

  it('a URL with no token never asks the server', () => {
    setup('/decision');
    expect(screen.getByText(/link is not valid/i)).toBeInTheDocument();
    expect(decisionsApi.view).not.toHaveBeenCalled();
  });
});

describe('answering', () => {
  it('confirm follows the server to where the decision landed', async () => {
    const user = userEvent.setup();
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(makeView());
    vi.mocked(decisionsApi.respond).mockResolvedValueOnce({
      state: 'accepted',
      redirectTo: '/studio/q1-sprint',
    });
    setup();
    await user.click(await screen.findByRole('button', { name: 'Accept' }));

    await waitFor(() => {
      expect(decisionsApi.respond).toHaveBeenCalledWith(TOKEN, 'confirm');
    });
    expect(await screen.findByText('StudioStub')).toBeInTheDocument();
  });

  it('decline stays put and says what happened', async () => {
    const user = userEvent.setup();
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(makeView());
    vi.mocked(decisionsApi.respond).mockResolvedValueOnce({
      state: 'declined',
      redirectTo: null,
    });
    setup();
    await user.click(await screen.findByRole('button', { name: 'Decline' }));

    await waitFor(() => {
      expect(decisionsApi.respond).toHaveBeenCalledWith(TOKEN, 'decline');
    });
    expect(await screen.findByText(/already declined/i)).toBeInTheDocument();
    expect(screen.queryByText('StudioStub')).not.toBeInTheDocument();
  });

  it('refreshes the inbox and the rail, which the deleted bell used to do', async () => {
    const user = userEvent.setup();
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(makeView());
    vi.mocked(decisionsApi.respond).mockResolvedValueOnce({
      state: 'declined',
      redirectTo: null,
    });
    const { client } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await user.click(await screen.findByRole('button', { name: 'Decline' }));

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['notifications', 'unread'],
      });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['studios', 'user'] });
  });

  it('a refused answer converges the card to what the server now says', async () => {
    // The page's view can go stale while it sits open — the deadline passes,
    // somebody else answers. A refusal is the server saying so; the card must
    // follow it instead of keeping live buttons under an 'expired' label.
    const user = userEvent.setup();
    vi.mocked(decisionsApi.view)
      .mockResolvedValueOnce(makeView())
      .mockResolvedValueOnce(makeView({ state: 'expired' }));
    vi.mocked(decisionsApi.respond).mockRejectedValueOnce(
      new ApiException({ status: 409, code: 'CONFLICT', message: 'Too late' }),
    );
    setup();
    await user.click(await screen.findByRole('button', { name: 'Accept' }));

    expect(await screen.findByText(/request has ended/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('Too late');
  });

  it('a rejected answer toasts the server and leaves the buttons up', async () => {
    const user = userEvent.setup();
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(makeView());
    vi.mocked(decisionsApi.respond).mockRejectedValueOnce(
      new ApiException({
        status: 409,
        code: 'CONFLICT',
        message: 'Already decided',
      }),
    );
    setup();
    await user.click(await screen.findByRole('button', { name: 'Accept' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Already decided');
    });
    expect(
      screen.getByRole('button', { name: 'Accept' }),
    ).toBeInTheDocument();
  });
});

describe('the person who is not being asked', () => {
  it('is told so, and gets no buttons and no request details', async () => {
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(
      makeView({ isRecipient: false }),
    );
    setup();
    expect(await screen.findByText(/not yours to answer/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    // The body sentence is written to the recipient ("Ana invited YOU...").
    // Said to anyone else it is false, so this card carries no details at all.
    expect(screen.queryByText(/invited you to join/i)).toBeNull();
  });

  it.each([
    ['accepted', /already accepted/i],
    ['declined', /already declined/i],
    ['expired', /request has ended/i],
  ] as const)(
    'sees the not-yours card on a %s request, not a false statement about themselves',
    async (state, falseClaim) => {
      // The sender opening their own copied link after the recipient answered
      // used to read "You already accepted this" — a statement about the
      // viewer that is true only of somebody else.
      vi.mocked(decisionsApi.view).mockResolvedValueOnce(
        makeView({ state, isRecipient: false }),
      );
      setup();
      expect(
        await screen.findByText(/not yours to answer/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(falseClaim)).toBeNull();
    },
  );
});

describe('the clock on an answerable card', () => {
  it('is the same countdown the bell shows, not a static policy line', async () => {
    const threeDays = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(
      makeView({ expiresAt: threeDays }),
    );
    setup();
    await screen.findByRole('button', { name: 'Accept' });
    // One formatter with the bell (`expiresInLabel`), so the two surfaces can
    // never disagree about how long is left on the same request.
    expect(screen.getByText(/expires in 3d/i)).toBeInTheDocument();
    // "Within 7 days" belongs on the expired card, where it answers WHY the
    // request cannot be answered any more; here it contradicted the bell.
    expect(screen.queryByText(/within 7 days/i)).toBeNull();
  });
});

describe('accessibility', () => {
  it('has no axe violations on the answerable card', async () => {
    vi.mocked(decisionsApi.view).mockResolvedValueOnce(makeView());
    const { rendered } = setup();
    await screen.findByRole('button', { name: 'Accept' });
    await expectNoA11yViolations(rendered.container);
  });
});
