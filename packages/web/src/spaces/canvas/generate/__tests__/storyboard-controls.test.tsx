// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the multi-shot mode's controls say on their own: the shot list holds
 * only the shots, and the row under it shows either "+ Add shot" or, when a
 * shot cannot be added, the reason in its place.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import type * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { setLocale } from '@breatic/shared';
import { writePlainTextIntoBody } from '@breatic/shared/canvas/text-body';

import { AddShotRow, ShotList, nextOpenShot } from '@web/spaces/canvas/generate/storyboard-controls';

const NOOP = (): void => {};

afterEach(() => {
  setLocale('en');
});

/**
 * The add-shot row.
 * @param addBlocked - Why a shot cannot be added, if it cannot.
 * @returns The render result.
 */
function row(addBlocked?: string): ReturnType<typeof render> {
  return render(<AddShotRow maxShots={6} addBlocked={addBlocked} onAdd={NOOP} />);
}

/**
 * A shot's words, in a document so they can be read.
 * @param text - The words.
 * @returns The fragment.
 */
function words(text: string): Y.XmlFragment {
  const fragment = new Y.Doc().getXmlFragment('prompt');
  writePlainTextIntoBody(fragment, text);
  return fragment;
}

/**
 * The shot list with two or three shots, one open.
 * @param over - Props to change.
 * @returns The render result.
 */
function shotList(over: Partial<React.ComponentProps<typeof ShotList>> = {}): ReturnType<typeof render> {
  return render(
    <ShotList
      shots={[
        { id: 's0', duration: 2, prompt: words('A rooftop at dawn') },
        { id: 's1', duration: 3, prompt: words('She turns around') },
        { id: 's2', duration: 1, prompt: words('') },
      ]}
      expanded='s0'
      onExpand={NOOP}
      placeholder='Describe this shot'
      onStep={NOOP}
      onRemove={NOOP}
      renderEditor={(shot) => <textarea data-testid={`box-${shot.id}`} />}
      {...over}
    />,
  );
}

describe('the shot list', () => {
  it('holds only the shots', () => {
    shotList();

    expect(screen.getByTestId('generate-storyboard-shot-2')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-storyboard-add')).toBeNull();
  });

  it('shows the open shot\'s box and only a line for each other shot', () => {
    shotList();

    expect(screen.getByTestId('box-s0')).toBeVisible();
    expect(screen.getByTestId('box-s1')).not.toBeVisible();
    expect(screen.getByTestId('generate-storyboard-shot-2')).toHaveTextContent('She turns around');
    expect(screen.getByTestId('generate-storyboard-shot-3')).toHaveTextContent('Describe this shot');
  });

  it('opens a collapsed shot when its row is clicked', () => {
    const onExpand = vi.fn();
    shotList({ onExpand });

    fireEvent.click(screen.getByRole('button', { name: /Shot 2/ }));

    expect(onExpand).toHaveBeenCalledWith('s1');
  });

  it('keeps the seconds and the remove button working on a collapsed shot', () => {
    const onStep = vi.fn();
    const onRemove = vi.fn();
    const onExpand = vi.fn();
    shotList({ onStep, onRemove, onExpand });

    fireEvent.click(screen.getByTestId('generate-storyboard-shot-2-less'));
    fireEvent.click(screen.getByTestId('generate-storyboard-shot-2-remove'));

    expect(onStep).toHaveBeenCalledWith('s1', -1);
    expect(onRemove).toHaveBeenCalledWith('s1');
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('leaves every shot box alone when another shot opens', () => {
    const renderEditor = vi.fn((shot: { id: string }) => <textarea data-testid={`box-${shot.id}`} />);
    const shots = [
      { id: 's0', duration: 2, prompt: words('A rooftop at dawn') },
      { id: 's1', duration: 3, prompt: words('She turns around') },
    ];
    const { rerender } = shotList({ shots, renderEditor });
    renderEditor.mockClear();

    rerender(
      <ShotList
        shots={shots}
        expanded='s1'
        onExpand={NOOP}
        placeholder='Describe this shot'
        onStep={NOOP}
        onRemove={NOOP}
        renderEditor={renderEditor}
      />,
    );

    expect(screen.getByTestId('box-s1')).toBeVisible();
    expect(renderEditor).not.toHaveBeenCalled();
  });

  it('names the shots in the language the reader switches to', () => {
    shotList();

    act(() => setLocale('zh-CN'));

    expect(screen.getByTestId('generate-storyboard-shot-2')).toHaveTextContent('镜头 2');
  });

  it('draws a lone shot with its title row as today, not as a row to click', () => {
    shotList({ shots: [{ id: 's0', duration: 5, prompt: words('') }] });

    expect(screen.getByTestId('generate-storyboard-shot-1')).toHaveTextContent('Shot 1');
    expect(screen.queryByRole('button', { name: /Shot 1/ })).toBeNull();
    expect(screen.getByTestId('generate-storyboard-shot-1-remove')).toBeDisabled();
    expect(screen.getByTestId('box-s0')).toBeVisible();
  });
});

describe('the shot that stays open (#1201)', () => {
  const list = (...ids: string[]): Array<{ id: string }> => ids.map((id) => ({ id }));

  it('opens the first shot when none is open yet', () => {
    expect(nextOpenShot([], list('a', 'b'), null)).toBe('a');
  });

  it('opens nothing when there are no shots', () => {
    expect(nextOpenShot(list('a'), [], 'a')).toBeNull();
  });

  it('opens the one after the removed open shot, even when the same change adds a shot before it', () => {
    expect(nextOpenShot(list('a', 'b', 'c'), list('x', 'a', 'c'), 'b')).toBe('c');
  });

  it('opens the one before the removed open shot when nothing after it is left', () => {
    expect(nextOpenShot(list('a', 'b', 'c'), list('a', 'x'), 'c')).toBe('a');
  });

  const change = fc
    .record({
      before: fc.uniqueArray(fc.integer({ min: 0, max: 20 }), { maxLength: 8 }),
      added: fc.uniqueArray(fc.integer({ min: 100, max: 120 }), { maxLength: 4 }),
    })
    .chain(({ before, added }) => {
      const seen = before.map((n) => `s${n}`);
      return fc.record({
        seen: fc.constant(seen),
        shots: fc.shuffledSubarray([...seen, ...added.map((n) => `s${n}`)]),
        opened: seen.length > 0 ? fc.option(fc.constantFrom(...seen), { nil: null }) : fc.constant(null),
      });
    });

  it('keeps the open shot while it is there, and otherwise opens a shot that is there', () => {
    fc.assert(fc.property(change, ({ seen, shots, opened }) => {
      const next = nextOpenShot(list(...seen), list(...shots), opened);
      if (shots.length === 0) return next === null;
      if (opened !== null && shots.includes(opened)) return next === opened;
      return next !== null && shots.includes(next);
    }));
  });

  it('opens the nearest shot left after the removed one, else the nearest before it', () => {
    fc.assert(fc.property(change, ({ seen, shots, opened }) => {
      if (opened === null || shots.includes(opened)) return true;
      const next = nextOpenShot(list(...seen), list(...shots), opened);
      const at = seen.indexOf(opened);
      const kept = (id: string): boolean => shots.includes(id);
      const after = seen.slice(at + 1).filter(kept);
      const before = seen.slice(0, at).filter(kept);
      if (after.length > 0) return next === after[0];
      if (before.length > 0) return next === before[before.length - 1];
      return next === (shots[0] ?? null);
    }));
  });

  it('opens the same shot whatever else the change adds, while an old shot is left', () => {
    fc.assert(fc.property(change, ({ seen, shots, opened }) => {
      const kept = shots.filter((id) => seen.includes(id));
      if (opened === null || kept.length === 0) return true;
      return nextOpenShot(list(...seen), list(...shots), opened) === nextOpenShot(list(...seen), list(...kept), opened);
    }));
  });
});

describe('adding a shot', () => {
  it('shows the reason in place of the button when every second is spoken for', () => {
    row('canvas.generatePanel.storyboard.noSecondToSpare');

    expect(screen.queryByTestId('generate-storyboard-add')).toBeNull();
    expect(screen.getByTestId('generate-storyboard-add-blocked')).toHaveTextContent('Lengthen the video to add a shot');
  });

  it('names the shot cap when no more shots are taken', () => {
    row('canvas.generatePanel.storyboard.shotCapReached');

    expect(screen.getByTestId('generate-storyboard-add-blocked')).toHaveTextContent('6');
  });

  it('shows no reason while a shot can be added', () => {
    row();

    expect(screen.getByTestId('generate-storyboard-add')).toBeEnabled();
    expect(screen.queryByTestId('generate-storyboard-add-blocked')).toBeNull();
  });

  it('sizes the button to its words', () => {
    row();

    expect(screen.getByTestId('generate-storyboard-add').className).not.toMatch(/\b(flex-1|w-full)\b/);
  });
});
