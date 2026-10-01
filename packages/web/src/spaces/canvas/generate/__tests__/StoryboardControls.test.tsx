// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the storyboard controls say on their own (#2218): whether the switch
 * is on, and what to do when no shot can be added.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ShotList, StoryboardSwitchRow } from '@web/spaces/canvas/generate/StoryboardControls';

const NOOP = (): void => {};

/**
 * The list with the given shots' seconds.
 * @param durations - Each shot's seconds.
 * @param total - The video's seconds.
 * @returns The render result.
 */
function list(durations: number[], total: number): ReturnType<typeof render> {
  return render(
    <ShotList
      shots={durations.map((duration, index) => ({ id: `s${index}`, duration }))}
      total={total}
      maxShots={6}
      onBack={NOOP}
      onStep={NOOP}
      onRemove={NOOP}
      onAdd={NOOP}
      renderEditor={() => null}
    />,
  );
}

describe('the storyboard switch row', () => {
  it('says Off while the storyboard is off', () => {
    render(<StoryboardSwitchRow kind='off' onToggle={NOOP} onEnterShots={NOOP} />);

    expect(screen.getByTestId('generate-storyboard-state')).toHaveTextContent('Off');
  });

  it('says On while either tier is on', () => {
    render(<StoryboardSwitchRow kind='auto' onToggle={NOOP} onEnterShots={NOOP} />);

    expect(screen.getByTestId('generate-storyboard-state')).toHaveTextContent('On');
  });
});

describe('adding a shot', () => {
  it('names the next step when every second is spoken for', () => {
    list([1, 1, 1, 1, 1], 5);

    expect(screen.getByTestId('generate-storyboard-add-blocked')).toHaveTextContent(
      'Lengthen the video to add a shot',
    );
  });

  it('keeps the button the same width whether or not it can act', () => {
    list([2, 3], 5);
    const open = screen.getByTestId('generate-storyboard-add').className;
    list([1, 1, 1, 1, 1], 5);
    const blocked = screen.getAllByTestId('generate-storyboard-add')[1]?.className;

    expect(open).not.toContain('flex-1');
    expect(blocked).toBe(open);
  });
});
