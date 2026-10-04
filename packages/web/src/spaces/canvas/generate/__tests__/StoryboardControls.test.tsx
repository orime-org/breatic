// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the multi-shot mode's controls say on their own: the shot list holds
 * only the shots, and the row under it adds one, or says why it cannot, to
 * the left of the button on the same line.
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
  it('greys the button and names the next step to its left on the same line when every second is spoken for', () => {
    row('canvas.generatePanel.storyboard.noSecondToSpare');

    const button = screen.getByTestId('generate-storyboard-add');
    expect(button).toBeDisabled();
    const reason = screen.getByTestId('generate-storyboard-add-blocked');
    expect(reason).toHaveTextContent('Lengthen the video to add a shot');
    expect(reason.parentElement).toBe(button.parentElement);
    expect(reason.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('sizes the button to its words and keeps it the same whether or not it can act', () => {
    row();
    const open = screen.getByTestId('generate-storyboard-add').className;
    row('canvas.generatePanel.storyboard.noSecondToSpare');
    const blocked = screen.getAllByTestId('generate-storyboard-add')[1]?.className;

    expect(open).not.toMatch(/\b(flex-1|w-full)\b/);
    expect(blocked).toBe(open);
  });
});
