// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The template button in a generate panel's corner and the list it opens
 * (inner#977, inner#1345 A6): every panel lists the registry's templates for
 * its node type, and a template is available only when every one of its
 * generate nodes runs on a model this deployment serves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
  GENERATION_TEMPLATES,
  setLocaleMessages,
  templatesFor,
  type GenerationNodeType,
  type GenerationTemplate,
} from '@breatic/shared';
import en from '@locales/en.json';

vi.mock('@breatic/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@breatic/shared')>();
  return { ...actual, templatesFor: vi.fn(actual.templatesFor) };
});

import { TooltipProvider } from '@web/components/ui/tooltip';
import { TemplateMenu } from '@web/spaces/canvas/generate/TemplateMenu';

const TEMPLATE_MODEL = 'nano-banana-pro-edit-ultra';

/**
 * A two-generation fixture anchored on the given node type: an image
 * generation upstream on one model feeding the anchor on another.
 * @param type - The anchor's node type.
 * @returns The template.
 */
function twoStep(type: GenerationNodeType): GenerationTemplate {
  return {
    id: 'fixture-two-step',
    anchor: 'final',
    nodes: [
      { key: 'final', role: 'generate', type, mode: 'any', model: 'final-model', params: {} },
      { key: 'first', role: 'generate', type: 'image', mode: 't2i', model: 'first-model', params: {} },
    ],
    edges: [{ from: 'first', to: 'final' }],
    inputs: [],
    steps: [],
    agentNote: 'a fixture',
  };
}

afterEach(() => {
  vi.mocked(templatesFor).mockReset();
  setLocaleMessages('en', en as Record<string, unknown>);
});

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
  render(
    <TooltipProvider>
      <TemplateMenu nodeType={nodeType} models={models} onPick={(t) => onPick(t.id)} />
    </TooltipProvider>,
  );
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
    const grid = GENERATION_TEMPLATES.find((template) => template.id === 'storyboard-grid-25');
    const anchor = grid?.nodes.find((n) => n.key === grid.anchor);
    expect(anchor?.role === 'generate' ? anchor.model : undefined).toBe(TEMPLATE_MODEL);
  });

  it.each<GenerationNodeType>(['image', 'video', 'audio'])(
    'lists what the registry has for a %s panel, available when every generate node’s model is served',
    (type) => {
      vi.mocked(templatesFor).mockReturnValue([twoStep(type)]);
      setLocaleMessages('en', {
        ...en,
        canvas: {
          ...en.canvas,
          template: { ...en.canvas.template, 'fixture-two-step': { name: 'Two step', description: 'A fixture' } },
        },
      } as Record<string, unknown>);
      const onPick = vi.fn();
      open(type, [{ name: 'final-model' }, { name: 'first-model' }], onPick);
      expect(templatesFor).toHaveBeenCalledWith(type);
      const item = screen.getByTestId('generate-template-fixture-two-step');
      expect(item).toHaveTextContent('Two step');
      expect(item).not.toHaveAttribute('data-disabled');
      fireEvent.click(item);
      expect(onPick).toHaveBeenCalledWith('fixture-two-step');
    },
  );

  it('shows a template as unavailable when a non-anchor generate node’s model is not served', () => {
    vi.mocked(templatesFor).mockReturnValue([twoStep('image')]);
    const onPick = vi.fn();
    open('image', [{ name: 'final-model' }], onPick);
    const item = screen.getByTestId('generate-template-fixture-two-step');
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveTextContent('Unavailable');
    fireEvent.click(item);
    expect(onPick).not.toHaveBeenCalled();
  });
});
