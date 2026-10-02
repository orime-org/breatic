// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the storyboard controls say on their own (#2218, #2252): whether the
 * switch is on, which buttons end its row in each tier, and what to do when
 * no shot can be added.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ShotList, StoryboardSwitchRow } from '@web/spaces/canvas/generate/StoryboardControls';

const NOOP = (): void => {};

/**
 * The switch row in one tier.
 * @param kind - The stored tier.
 * @param addBlocked - Why a shot cannot be added, if it cannot.
 * @returns The render result.
 */
function row(
  kind: 'off' | 'auto' | 'custom',
  addBlocked?: string,
): ReturnType<typeof render> {
  return render(
    <StoryboardSwitchRow
      kind={kind}
      maxShots={6}
      addBlocked={addBlocked}
      onToggle={NOOP}
      onEnterShots={NOOP}
      onBack={NOOP}
      onAdd={NOOP}
    />,
  );
}

/**
 * The test ids of the buttons at the row's right end, in order.
 * @returns The ids.
 */
function trailingButtons(): (string | null)[] {
  const actions = screen.getByTestId('generate-storyboard-actions');
  return [...actions.querySelectorAll('button')].map((b) => b.getAttribute('data-testid'));
}

describe('the storyboard switch row', () => {
  it('says Off while the storyboard is off', () => {
    row('off');

    expect(screen.getByTestId('generate-storyboard-state')).toHaveTextContent('Off');
  });

  it('says On while either tier is on', () => {
    row('auto');

    expect(screen.getByTestId('generate-storyboard-state')).toHaveTextContent('On');
  });

  it.each(['off', 'auto'] as const)('ends with the per-shot button while %s', (kind) => {
    row(kind);
    const actions = screen.getByTestId('generate-storyboard-actions');

    expect(trailingButtons()).toEqual(['generate-storyboard-per-shot']);
    expect(actions.parentElement?.lastElementChild).toBe(actions);
    expect(actions.className).toContain('ml-auto');
  });

  it('ends with add-shot then back in the same place while split by hand', () => {
    row('custom');
    const actions = screen.getByTestId('generate-storyboard-actions');

    expect(trailingButtons()).toEqual(['generate-storyboard-add', 'generate-storyboard-back']);
    expect(actions.parentElement?.lastElementChild).toBe(actions);
    expect(actions.className).toContain('ml-auto');
  });

  it('does not say the main prompt is kept while split by hand', () => {
    row('custom');

    expect(screen.queryByText('Main prompt kept')).toBeNull();
  });
});

describe('the shot list', () => {
  it('holds only the shots', () => {
    render(
      <ShotList
        shots={[{ id: 's0', duration: 2 }, { id: 's1', duration: 3 }]}
        onStep={NOOP}
        onRemove={NOOP}
        renderEditor={() => null}
      />,
    );

    expect(screen.queryByTestId('generate-storyboard-back')).toBeNull();
    expect(screen.queryByTestId('generate-storyboard-add')).toBeNull();
  });
});

describe('adding a shot', () => {
  it('greys the button and names the next step on a line of its own when every second is spoken for', () => {
    row('custom', 'canvas.generatePanel.storyboard.noSecondToSpare');

    expect(screen.getByTestId('generate-storyboard-add')).toBeDisabled();
    const reason = screen.getByTestId('generate-storyboard-add-blocked');
    expect(reason).toHaveTextContent('Lengthen the video to add a shot');
    expect(screen.getByTestId('generate-storyboard-actions')).not.toContainElement(reason);
  });

  it('names the shot cap when the model takes no more shots', () => {
    row('custom', 'canvas.generatePanel.storyboard.shotCapReached');

    expect(screen.getByTestId('generate-storyboard-add-blocked')).toHaveTextContent('6');
  });

  it('shows no reason while a shot can be added', () => {
    row('custom');

    expect(screen.getByTestId('generate-storyboard-add')).toBeEnabled();
    expect(screen.queryByTestId('generate-storyboard-add-blocked')).toBeNull();
  });

  it('keeps the button the same width whether or not it can act', () => {
    row('custom');
    const open = screen.getByTestId('generate-storyboard-add').className;
    row('custom', 'canvas.generatePanel.storyboard.noSecondToSpare');
    const blocked = screen.getAllByTestId('generate-storyboard-add')[1]?.className;

    expect(open).not.toContain('flex-1');
    expect(blocked).toBe(open);
  });
});
