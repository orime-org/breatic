// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the multi-shot mode's controls say on their own: the shot list holds
 * only the shots, and the row under it shows either "+ Add shot" or, when a
 * shot cannot be added, the reason in its place.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { writePlainTextIntoBody } from '@breatic/shared/canvas/text-body';

import { AddShotRow, ShotList } from '@web/spaces/canvas/generate/storyboard-controls';

const NOOP = (): void => {};

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

  it('draws a lone shot with its title row as today, not as a row to click', () => {
    shotList({ shots: [{ id: 's0', duration: 5, prompt: words('') }] });

    expect(screen.getByTestId('generate-storyboard-shot-1')).toHaveTextContent('Shot 1');
    expect(screen.queryByRole('button', { name: /Shot 1/ })).toBeNull();
    expect(screen.getByTestId('generate-storyboard-shot-1-remove')).toBeDisabled();
    expect(screen.getByTestId('box-s0')).toBeVisible();
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
