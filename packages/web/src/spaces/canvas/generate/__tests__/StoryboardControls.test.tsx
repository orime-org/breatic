// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the multi-shot mode's controls say on their own: the shot list holds
 * only the shots, and the row under it shows either "+ Add shot" or, when a
 * shot cannot be added, the reason in its place.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AddShotRow, ShotList } from '@web/spaces/canvas/generate/StoryboardControls';

const NOOP = (): void => {};

/**
 * The add-shot row.
 * @param addBlocked - Why a shot cannot be added, if it cannot.
 * @returns The render result.
 */
function row(addBlocked?: string): ReturnType<typeof render> {
  return render(<AddShotRow maxShots={6} addBlocked={addBlocked} onAdd={NOOP} />);
}

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

    expect(screen.getByTestId('generate-storyboard-shot-2')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-storyboard-add')).toBeNull();
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
