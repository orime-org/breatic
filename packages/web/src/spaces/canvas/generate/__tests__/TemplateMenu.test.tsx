// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The template button in a generate panel's corner and the list it opens
 * (inner#977).
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { findTemplate, type GenerationNodeType } from '@breatic/shared';

import { TemplateMenu } from '@web/spaces/canvas/generate/TemplateMenu';

const TEMPLATE_MODEL = 'nano-banana-pro-edit-ultra';

/**
 * Renders the menu and opens it.
 * @param nodeType - The panel's node type.
 * @param models - The models this deployment serves for it.
 * @param onPick - The pick handler.
 * @returns Nothing.
 */
function open(
  nodeType: GenerationNodeType,
  models: readonly { name: string }[] = [{ name: TEMPLATE_MODEL }],
  onPick: (id: string) => void = () => {},
): void {
  render(<TemplateMenu nodeType={nodeType} models={models} onPick={(t) => onPick(t.id)} />);
  fireEvent.keyDown(screen.getByTestId('generate-template-trigger'), { key: 'Enter' });
}

describe('TemplateMenu', () => {
  it('lists the templates of the panel’s node type with a name and a line on each', () => {
    open('image');
    expect(screen.getByTestId('generate-template-storyboard-grid-25')).toHaveTextContent('25-panel storyboard');
    expect(screen.getByTestId('generate-template-costume-sheet')).toBeInTheDocument();
  });

  it('opens on an empty state where the node type has no templates', () => {
    open('video');
    expect(screen.getByTestId('generate-template-empty')).toHaveTextContent('No templates');
    expect(screen.queryByTestId('generate-template-storyboard-grid-25')).toBeNull();
  });

  it('hands the picked template to the panel', () => {
    const onPick = vi.fn();
    open('image', undefined, onPick);
    fireEvent.click(screen.getByTestId('generate-template-costume-sheet'));
    expect(onPick).toHaveBeenCalledWith('costume-sheet');
  });

  it('shows a template whose model this deployment lacks as unavailable and does not pick it', () => {
    const onPick = vi.fn();
    open('image', [], onPick);
    const item = screen.getByTestId('generate-template-storyboard-grid-25');
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveTextContent('Unavailable');
    fireEvent.click(item);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('reads every template of the registry the test names', () => {
    expect(findTemplate('storyboard-grid-25')?.model).toBe(TEMPLATE_MODEL);
  });
});
