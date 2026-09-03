// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 §6.3 — the voice picker.
 *
 * The list comes from upstream, so searching happens there too. cmdk filters
 * what it has rendered by default, and the two together lie: a term whose
 * match is on the next page comes back from the server and is then hidden by
 * the local filter, leaving "no matches" over a list that has them.
 *
 * Samples play through one audio element. Two playing at once is two voices
 * over each other, and neither is the one being judged.
 *
 * `useTranslation` echoes its key so assertions name the string the panel
 * asks for rather than today's English wording.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { VoicePicker } from '@web/spaces/canvas/generate/VoicePicker';
import { expectChosenFill } from '@web/test-utils/selection-fill';
import type { VoiceListState } from '@web/spaces/canvas/generate/voice-list-state';
import type { Voice } from '@breatic/shared';

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string): string => key,
}));

const ALPHA: Voice = {
  id: 'alpha',
  name: 'Alpha',
  previewUrl: 'https://example.test/alpha.mp3',
};
const BETA: Voice = { id: 'beta', name: 'Beta' };

/**
 * Builds a list state for the picker to render.
 * @param over - The fields this case cares about.
 * @returns A complete state.
 */
function state(over: Partial<VoiceListState> = {}): VoiceListState {
  return {
    status: 'ready',
    voices: [ALPHA, BETA],
    query: '',
    hasMore: false,
    fetching: false,
    loadingMore: false,
    moreFailed: false,
    requestId: 1,
    ...over,
  };
}

/**
 * The element that actually scrolls: the ScrollArea viewport CommandList
 * wraps its children in, which is where the paging listener lives.
 * @returns That element.
 * @throws {Error} When the list is not open.
 */
function scrollerOf(): HTMLElement {
  const el = document.querySelector('[data-radix-scroll-area-viewport]');
  if (!el) throw new Error('the voice list is not open');
  return el as HTMLElement;
}

/**
 * The row wrapping one voice — the element carrying the fill and the hover.
 *
 * The row holds two controls side by side (choose, sample), so the fill lives
 * on their container rather than on either button.
 * @param id - The voice's id.
 * @returns That row.
 * @throws {Error} When the row is not on screen.
 */
function rowOf(id: string): HTMLElement {
  const btn = screen.getByTestId(`generate-voice-option-${id}`);
  const row = btn.parentElement;
  if (!row) throw new Error(`voice row ${id} has no container`);
  return row;
}

/** The props every case supplies, so a case names only what it exercises. */
const NOOPS = {
  onOpenChange: (): void => {},
  onQueryChange: (): void => {},
  onPick: (): void => {},
  onLoadMore: (): void => {},
};

/**
 * Renders the picker with its list open.
 * @param over - Props this case overrides.
 * @returns Nothing; assertions read from the screen.
 */
function open(over: Record<string, unknown> = {}): void {
  render(
    <VoicePicker
      list={state()}
      selectedId={null}
      selectedName={null}
      {...NOOPS}
      {...over}
    />,
  );
  fireEvent.click(screen.getByTestId('generate-voice-trigger'));
}

describe('VoicePicker trigger (#1960 A2)', () => {
  it('shows the chosen voice by name, not by its id', () => {
    render(
      <VoicePicker
        list={state()}
        selectedId='JBFqnCBsd6RMkjVDRZzb'
        selectedName='George'
        {...NOOPS}
      />,
    );
    const trigger = screen.getByTestId('generate-voice-trigger');
    expect(trigger).toHaveTextContent('George');
    expect(trigger).not.toHaveTextContent('JBFqnCBsd6RMkjVDRZzb');
  });

  it('falls back to the id when the name could not be fetched', () => {
    render(
      <VoicePicker
        list={state()}
        selectedId='JBFqnCBsd6RMkjVDRZzb'
        selectedName={null}
        {...NOOPS}
      />,
    );
    expect(screen.getByTestId('generate-voice-trigger')).toHaveTextContent(
      'JBFqnCBsd6RMkjVDRZzb',
    );
  });

  it('says a voice is still to be picked when none is', () => {
    render(
      <VoicePicker list={state()} selectedId={null} selectedName={null} {...NOOPS} />,
    );
    expect(screen.getByTestId('generate-voice-trigger')).toHaveTextContent(
      'canvas.generatePanel.voicePlaceholder',
    );
  });

  it('tells the container when it opens and when it collapses', () => {
    const onOpenChange = vi.fn();
    render(
      <VoicePicker
        list={state({ status: 'idle', voices: [] })}
        selectedId={null}
        selectedName={null}
        {...NOOPS}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-voice-trigger'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('VoicePicker list (#1960 A2)', () => {
  it('lists every voice the container handed it', () => {
    open();
    expect(screen.getByTestId('generate-voice-option-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('generate-voice-option-beta')).toBeInTheDocument();
  });

  it('keeps showing voices whose names do not match what was typed', () => {
    // Searching happens upstream. cmdk's own filtering would hide these, and
    // the picker would claim no matches over the page the server just sent.
    open({ list: state({ query: 'zzz' }) });
    expect(screen.getByTestId('generate-voice-option-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('generate-voice-option-beta')).toBeInTheDocument();
  });

  it('reports what was typed rather than filtering in place', () => {
    const onQueryChange = vi.fn();
    open({ onQueryChange });
    fireEvent.change(screen.getByTestId('generate-voice-search'), {
      target: { value: 'deep' },
    });
    expect(onQueryChange).toHaveBeenCalledWith('deep');
  });

  it('hands back the picked voice and closes', () => {
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    open({ onPick, onOpenChange });
    fireEvent.click(screen.getByTestId('generate-voice-option-beta'));
    expect(onPick).toHaveBeenCalledWith(BETA);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('shows the vendor description under the name, where there is one', () => {
    open({
      list: state({
        voices: [{ ...ALPHA, description: 'Warm British narrator' }],
      }),
    });
    expect(screen.getByTestId('generate-voice-option-alpha')).toHaveTextContent(
      'Warm British narrator',
    );
  });

  it('leaves the row to the name alone when no description came', () => {
    open();
    expect(screen.getByTestId('generate-voice-option-beta')).toHaveTextContent(
      'Beta',
    );
    expect(
      screen.getByTestId('generate-voice-option-beta').querySelectorAll('span'),
    ).toHaveLength(2);
  });

  it('marks the chosen voice by fill, since only one can be chosen', () => {
    open({ selectedId: 'beta', selectedName: 'Beta' });
    expectChosenFill(rowOf('beta'));
  });

  it('keeps the chosen fill under the pointer', () => {
    // Hover lifts a row to `accent`, one step below the `accent-strong` the
    // chosen one carries — applied to the chosen row it would drop it to the
    // colour its neighbours take under the pointer.
    open({ selectedId: 'beta', selectedName: 'Beta' });
    expect(rowOf('beta').className).not.toContain('hover:bg-accent');
    expect(rowOf('alpha').className).toContain('hover:bg-accent');
  });

  it('lifts the label with the fill, the way the model picker does', () => {
    // ModelPicker's rows are ghost Buttons, whose hover is
    // `hover:bg-accent hover:text-accent-foreground` — both halves.
    open();
    expect(screen.getByTestId('generate-voice-option-alpha').className).toContain(
      'hover:text-accent-foreground',
    );
  });
});

describe('VoicePicker states (#1960 A6)', () => {
  it('says nothing matched when the search came back empty', () => {
    open({ list: state({ status: 'empty', voices: [], query: 'zzz' }) });
    expect(screen.getByTestId('generate-voice-empty')).toBeInTheDocument();
  });

  it('offers a retry when the request failed', () => {
    const onOpenChange = vi.fn();
    open({ list: state({ status: 'failed', voices: [] }), onOpenChange });
    expect(screen.getByTestId('generate-voice-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('generate-voice-retry'));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it('keeps the search box usable while a request is failing', () => {
    open({ list: state({ status: 'failed', voices: [] }) });
    expect(screen.getByTestId('generate-voice-search')).toBeInTheDocument();
  });
});

describe('VoicePicker paging (#1960 §7.1)', () => {
  it('asks for the next page when the list is scrolled to the end', () => {
    const onLoadMore = vi.fn();
    open({ list: state({ hasMore: true }), onLoadMore });
    const scroller = scrollerOf();
    Object.defineProperty(scroller, 'scrollHeight', { value: 400, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 200, configurable: true });
    fireEvent.scroll(scroller);
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('does not ask while the list is scrolled nowhere near the end', () => {
    const onLoadMore = vi.fn();
    open({ list: state({ hasMore: true }), onLoadMore });
    const scroller = scrollerOf();
    Object.defineProperty(scroller, 'scrollHeight', { value: 400, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 0, configurable: true });
    fireEvent.scroll(scroller);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('shows the loaded voices while the next page is on its way', () => {
    open({ list: state({ hasMore: true, loadingMore: true }) });
    expect(screen.getByTestId('generate-voice-option-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('generate-voice-loading-more')).toBeInTheDocument();
  });
});

describe('VoicePicker samples (#1960 A2)', () => {
  let play: ReturnType<typeof vi.fn>;
  let pause: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom implements neither, and both are what this behaviour is made of.
    play = vi.fn().mockResolvedValue(undefined);
    pause = vi.fn();
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(play);
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns the sample button into a stop while that voice is playing', () => {
    open();
    const sample = screen.getByTestId('generate-voice-sample-alpha');
    expect(sample).toHaveAttribute('data-playing', 'false');
    fireEvent.click(sample);
    expect(
      screen.getByTestId('generate-voice-sample-alpha'),
    ).toHaveAttribute('data-playing', 'true');
  });

  it('offers a sample on a voice that has one', () => {
    open();
    expect(screen.getByTestId('generate-voice-sample-alpha')).toBeInTheDocument();
  });

  it('offers none on a voice the vendor gave no sample for', () => {
    open();
    expect(screen.queryByTestId('generate-voice-sample-beta')).toBeNull();
  });

  it('plays the sample without choosing that voice', () => {
    const onPick = vi.fn();
    open({ onPick });
    fireEvent.click(screen.getByTestId('generate-voice-sample-alpha'));
    expect(play).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('stops the sample when the picker goes away', () => {
    // Nothing else holds this audio element, so a sample started here would
    // keep playing over a panel that is no longer on screen.
    const { unmount } = render(
      <VoicePicker
        list={state()}
        selectedId={null}
        selectedName={null}
        {...NOOPS}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-voice-trigger'));
    fireEvent.click(screen.getByTestId('generate-voice-sample-alpha'));
    pause.mockClear();
    unmount();
    expect(pause).toHaveBeenCalled();
  });

  it('stops whatever was playing before starting another sample', () => {
    open({
      list: state({
        voices: [ALPHA, { ...BETA, previewUrl: 'https://example.test/beta.mp3' }],
      }),
    });
    fireEvent.click(screen.getByTestId('generate-voice-sample-alpha'));
    pause.mockClear();
    fireEvent.click(screen.getByTestId('generate-voice-sample-beta'));
    expect(pause).toHaveBeenCalled();
  });
});

describe('VoicePicker when a next page fails (#1960 A6)', () => {
  it('says so at the end of the list, with a way to try again', () => {
    // Without a line of its own this renders exactly like reaching the end:
    // the loading row disappears and the list simply stops.
    const onLoadMore = vi.fn();
    open({ list: state({ hasMore: true, moreFailed: true }), onLoadMore });
    fireEvent.click(screen.getByTestId('generate-voice-more-retry'));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('says nothing there while a page is still on its way', () => {
    open({ list: state({ hasMore: true, loadingMore: true }) });
    expect(screen.queryByTestId('generate-voice-more-retry')).toBeNull();
  });
});

describe('the voice list answers Enter on its own buttons', () => {
  // Every button here sits inside cmdk's Command, whose root cancels Enter and
  // fires the highlighted ROW's select instead. Left alone, a keyboard user
  // asking for one thing gets a different voice chosen and the list closed.
  // `userEvent` follows the spec: a cancelled keydown skips the click.

  it('plays the sample the button belongs to, and picks nothing', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue();
    open({ onPick });
    screen.getByTestId('generate-voice-sample-alpha').focus();
    await user.keyboard('{Enter}');
    expect(play).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    play.mockRestore();
  });

  it('retries the list, and picks nothing', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    open({ onPick, onOpenChange, list: state({ status: 'failed', voices: [] }) });
    // Opening called it once already; only what Enter does counts here.
    onOpenChange.mockClear();
    screen.getByTestId('generate-voice-retry').focus();
    await user.keyboard('{Enter}');
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('retries the next page, and picks nothing', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onLoadMore = vi.fn();
    open({ onPick, onLoadMore, list: state({ hasMore: true, moreFailed: true }) });
    screen.getByTestId('generate-voice-more-retry').focus();
    await user.keyboard('{Enter}');
    expect(onLoadMore).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('VoicePicker rows are the option shape the rest of the app uses', () => {
  it('draws each voice as a button, the way the model picker does', () => {
    // LangSwitcher / ThemeToggle / ModelPicker / ModeToggle / ParamOptionGroup
    // are all a column of ghost menu-item Buttons. A row that is a real button
    // is reachable by Tab and draws its own focus ring; nothing here depends
    // on a list library's cursor attribute.
    open();
    const row = screen.getByTestId('generate-voice-option-alpha');
    expect(row.tagName).toBe('BUTTON');
  });

  it('reports the chosen row through aria-pressed, as the model picker does', () => {
    open({ selectedId: 'beta' });
    expect(screen.getByTestId('generate-voice-option-beta')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('generate-voice-option-alpha')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('puts the sample button after the name, at the end of the row', () => {
    // The row reads name, then description, then the control — the order the
    // demo lays out (user 2026-09-02).
    open();
    const name = screen.getByText('Alpha');
    const sample = screen.getByTestId('generate-voice-sample-alpha');
    expect(
      name.compareDocumentPosition(sample) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });


  it('names the voice on the trigger behind a speaker icon', () => {
    // The model picker carries the vendor icon in the same spot; without one
    // the third pill is a bare proper noun beside the model's own.
    render(
      <VoicePicker
        list={state()}
        selectedId='alpha'
        selectedName='Alpha'
        {...NOOPS}
      />,
    );
    const trigger = screen.getByTestId('generate-voice-trigger');
    expect(trigger.querySelectorAll('svg').length).toBeGreaterThan(1);
  });
});

describe('VoicePicker while the first page is on its way', () => {
  it('holds the list open at its own height with placeholder rows', () => {
    // A single line of centred text collapses the popover, and the popover
    // grows upward — so the search box the user is typing into moves under
    // their hands on every keystroke.
    open({ list: state({ status: 'loading', voices: [] }) });
    expect(
      screen.getAllByTestId('generate-voice-skeleton').length,
    ).toBeGreaterThan(1);
  });
});
