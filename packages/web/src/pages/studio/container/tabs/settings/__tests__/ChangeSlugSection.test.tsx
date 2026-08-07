// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The danger zone's slug entry: a button, and a dialog that holds the input.
 *
 * The gate is written as "only when the check says available" rather than
 * "unless the check says invalid", because an emptied field reports neither —
 * it reports idle. The version of this gate that lived in the basic-info form
 * had to be corrected for exactly that, and the correction travels with the
 * feature.
 *
 * Confirming does not close the dialog. On success the whole tab unmounts
 * anyway, since the address it is standing on has just stopped existing; on
 * failure the dialog is still there holding what the user typed, instead of
 * making them type it again.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ChangeSlugSection } from '@web/pages/studio/container/tabs/settings/ChangeSlugSection';
import { studiosApi } from '@web/data/api/studios';
import type { StudioDetail } from '@web/pages/studio/container/container-types';

// Interpolation values are rendered alongside the key, because one of the
// cases below is about what gets substituted into the address sentence.
vi.mock('@web/i18n/use-translation', () => ({
  useTranslation:
    () =>
      (key: string, params?: Record<string, unknown>): string =>
        params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));
vi.mock('@web/domain/use-debounce', () => ({
  useDebounce: <T,>(value: T): T => value,
}));
vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
    checkSlugAvailable: vi.fn().mockResolvedValue({ available: true }),
  },
}));

const STUDIO: StudioDetail = {
  id: 's1',
  slug: 'acme-studio',
  name: 'Acme',
  type: 'team',
  avatarUrl: null,
  bio: null,
  memberCount: 3,
  myStudioRole: 'admin',
};

const SLUG_LABEL = 'studio.container.settings.slug';

/** A render result that can be put into, and taken out of, the saving state. */
interface SectionHandle {
  /** Re-render with a save in flight, or no longer in flight. */
  setSaving: (saving: boolean) => void;
}

/**
 * Render the section.
 *
 * `setSaving` exists because the in-flight rules cannot be reached by
 * rendering straight into that state: with the field disabled from the start,
 * nothing can be typed, so the confirm button is off for want of a changed
 * value rather than for the reason under test.
 * @param props - Overrides for the section's props.
 * @param props.saving - Whether a save is in flight to begin with.
 * @param props.onSave - The save handler.
 * @returns The render result, plus a way to flip the saving flag.
 */
function renderSection(props: {
  saving?: boolean;
  onSave?: (patch: unknown) => void;
} = {}): ReturnType<typeof render> & SectionHandle {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSave = props.onSave ?? vi.fn();
  /**
   * Build the tree for a given saving flag.
   * @param saving - Whether a save is in flight.
   * @returns The element tree.
   */
  const tree = (saving: boolean): React.JSX.Element => (
    <QueryClientProvider client={qc}>
      <ChangeSlugSection studio={STUDIO} saving={saving} onSave={onSave} />
    </QueryClientProvider>
  );
  const result = render(tree(props.saving ?? false));
  return {
    ...result,
    setSaving: (saving: boolean): void => {
      result.rerender(tree(saving));
    },
  };
}

/**
 * Open the dialog and hand back its slug input.
 * @returns The slug input element.
 */
async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('settings-slug-open'));
  await waitFor(() =>
    expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument(),
  );
  return screen.getByLabelText(SLUG_LABEL);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
    available: true,
  });
});

describe('ChangeSlugSection — the entry point', () => {
  it('is a button, with the input out of reach until it is pressed', () => {
    renderSection();
    expect(screen.getByTestId('settings-slug-open')).toBeInTheDocument();
    expect(screen.queryByLabelText(SLUG_LABEL)).not.toBeInTheDocument();
  });

  it('opens onto the studio’s current slug', async () => {
    renderSection();
    const input = await openDialog();
    expect(input).toHaveValue(STUDIO.slug);
  });

  it('does not claim the address changes to the address it already has', async () => {
    // The sentence names both ends, and on open both ends are the same slug —
    // "the address changes from acme-studio to acme-studio" is the first thing
    // the user reads. The destination stays a placeholder until there is one.
    renderSection();
    await openDialog();
    const body = screen.getByTestId('settings-slug-body');
    expect(body).toHaveTextContent(`"oldSlug":"${STUDIO.slug}"`);
    expect(body).not.toHaveTextContent(`"newSlug":"${STUDIO.slug}"`);
  });

  it('names the destination once there is one', async () => {
    renderSection();
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-body')).toHaveTextContent(
        '"newSlug":"acme-renamed"',
      ),
    );
  });
});

describe('ChangeSlugSection — the confirm gate', () => {
  it('refuses the slug the studio already holds', async () => {
    renderSection();
    await openDialog();
    expect(screen.getByTestId('settings-slug-confirm')).toBeDisabled();
  });

  it('refuses an emptied field, which reports idle rather than invalid', async () => {
    renderSection();
    const input = await openDialog();
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-confirm')).toBeDisabled(),
    );
  });

  it('never asks the server whether the studio may keep its own slug', async () => {
    // The dialog opens holding it, and asking gets the truthful answer
    // "taken" — by the very studio doing the asking. Assert the request never
    // goes out, and that editing away and back leaves no taken error behind:
    // checking the confirm button instead would pass either way, since it is
    // disabled while the value is unchanged regardless.
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
      available: false,
      reason: 'taken',
    });
    renderSection();
    const input = await openDialog();

    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(studiosApi.checkSlugAvailable).toHaveBeenCalledWith(
        'acme-renamed',
        expect.anything(),
      ),
    );
    fireEvent.change(input, { target: { value: STUDIO.slug } });

    await waitFor(() =>
      expect(
        screen.queryByText('studio.container.dialog.slugTaken'),
      ).not.toBeInTheDocument(),
    );
    expect(studiosApi.checkSlugAvailable).not.toHaveBeenCalledWith(
      STUDIO.slug,
      expect.anything(),
    );
  });

  it('refuses a slug somebody else holds', async () => {
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
      available: false,
      reason: 'taken',
    });
    renderSection();
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(
        screen.getByText('studio.container.dialog.slugTaken'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('settings-slug-confirm')).toBeDisabled();
  });

  it('lets a free, well-formed slug through, and sends only the slug', async () => {
    const onSave = vi.fn();
    renderSection({ onSave });
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-confirm')).toBeEnabled(),
    );

    fireEvent.click(screen.getByTestId('settings-slug-confirm'));
    expect(onSave).toHaveBeenCalledWith({ slug: 'acme-renamed' });
  });

  it('shuts again the moment the request goes out, so it cannot be pressed twice', async () => {
    // Reached by typing FIRST and only then going in-flight. Rendering
    // straight into `saving` disables the field, so nothing can be typed and
    // the button is off for want of a changed value — which is how the first
    // version of this case passed without the clause it claimed to protect.
    const { setSaving } = renderSection();
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-confirm')).toBeEnabled(),
    );

    setSaving(true);
    expect(screen.getByTestId('settings-slug-confirm')).toBeDisabled();
  });
});

describe('ChangeSlugSection — while the request is in flight', () => {
  /**
   * Open the dialog, type a free slug, and put the section into the saving
   * state — the situation every case in this block is about.
   * @returns The handle, so a case can take it back out of that state.
   */
  async function reachInFlight(): Promise<SectionHandle> {
    const handle = renderSection();
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-confirm')).toBeEnabled(),
    );
    handle.setSaving(true);
    return handle;
  }

  /** Assert the dialog is still up and still holding what was typed. */
  function expectStillThere(): void {
    expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(SLUG_LABEL)).toHaveValue('acme-renamed');
  }

  it('does not let Escape close it', async () => {
    await reachInFlight();
    fireEvent.keyDown(screen.getByTestId('settings-slug-dialog'), {
      key: 'Escape',
    });
    expectStillThere();
  });

  it('does not let Cancel close it', async () => {
    await reachInFlight();
    fireEvent.click(screen.getByTestId('settings-slug-cancel'));
    expectStillThere();
  });

  it('does not let the header’s close button close it', async () => {
    await reachInFlight();
    fireEvent.click(screen.getByLabelText('Close'));
    expectStillThere();
  });

  it('does not let a click outside close it', async () => {
    await reachInFlight();
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expectStillThere();
  });

  it('lets it close again once the request is done', async () => {
    const { setSaving } = await reachInFlight();
    setSaving(false);
    fireEvent.click(screen.getByTestId('settings-slug-cancel'));
    await waitFor(() =>
      expect(
        screen.queryByTestId('settings-slug-dialog'),
      ).not.toBeInTheDocument(),
    );
  });
});

describe('ChangeSlugSection — after confirming', () => {
  it('keeps the dialog and the typed value, so a failure costs nothing', async () => {
    // Success unmounts this whole tab — the address it is standing on has just
    // been released. So the only state in which the dialog is still around
    // after a confirm is a failed one, and closing it there would throw away
    // what the user typed.
    const onSave = vi.fn();
    renderSection({ onSave });
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-confirm')).toBeEnabled(),
    );

    fireEvent.click(screen.getByTestId('settings-slug-confirm'));

    expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(SLUG_LABEL)).toHaveValue('acme-renamed');
  });

  it('forgets the draft when the dialog is dismissed instead', async () => {
    renderSection();
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    fireEvent.click(screen.getByTestId('settings-slug-cancel'));

    await waitFor(() =>
      expect(
        screen.queryByTestId('settings-slug-dialog'),
      ).not.toBeInTheDocument(),
    );
    const reopened = await openDialog();
    expect(reopened).toHaveValue(STUDIO.slug);
  });
});
