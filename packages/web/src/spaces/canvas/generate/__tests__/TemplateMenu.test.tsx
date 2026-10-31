// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The template button in a generate panel's corner and the list it opens
 * (inner#977, inner#1345 A6, inner#1807): every panel lists the creative goals
 * of its node type's templates, each opening a submenu of those templates, and
 * a template is available only when every one of its generate nodes runs on a
 * model this deployment serves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
  GENERATION_TEMPLATES,
  setLocaleMessages,
  templateGoalsFor,
  type GenerationNodeType,
  type GenerationTemplate,
} from '@breatic/shared';
import en from '@locales/en.json';

vi.mock('@breatic/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@breatic/shared')>();
  return { ...actual, templateGoalsFor: vi.fn(actual.templateGoalsFor) };
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
    goal: 'character',
    triggers: { asks: ['a fixture'], offerWhen: ['a fixture is wanted'] },
  };
}

afterEach(() => {
  vi.mocked(templateGoalsFor).mockReset();
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

/**
 * Opens one goal's submenu from the keyboard, as Radix opens a sub trigger.
 * @param goal - The goal.
 * @returns Nothing.
 */
function openGoal(goal: string): void {
  fireEvent.keyDown(screen.getByTestId(`generate-template-goal-${goal}`), { key: 'ArrowRight' });
}

/**
 * Serves one fixture template under the character goal, with its strings.
 * @param type - The anchor's node type.
 * @returns Nothing.
 */
function serveFixture(type: GenerationNodeType): void {
  vi.mocked(templateGoalsFor).mockReturnValue([{ goal: 'character', templates: [twoStep(type)] }]);
  setLocaleMessages('en', {
    ...en,
    canvas: {
      ...en.canvas,
      template: { ...en.canvas.template, 'fixture-two-step': { name: 'Two step', description: 'A fixture' } },
    },
  } as Record<string, unknown>);
}

describe('TemplateMenu', () => {
  it('lists the creative goals of the panel’s node type in order, each with how many templates it holds', () => {
    open('image');
    const rows = screen.getAllByTestId(/^generate-template-goal-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(
      templateGoalsFor('image').map(({ goal }) => `generate-template-goal-${goal}`),
    );
    for (const { goal, templates } of templateGoalsFor('image')) {
      const row = screen.getByTestId(`generate-template-goal-${goal}`);
      expect(row).toHaveTextContent(String(en.canvas.template.goal[goal as keyof typeof en.canvas.template.goal]));
      expect(row).toHaveTextContent(String(templates.length));
    }
    expect(screen.queryByTestId('generate-template-storyboard-grid-25')).toBeNull();
  });

  it('opens a goal on its templates, each a name with a line under it', () => {
    open('image');
    openGoal('comics-storyboards');
    expect(screen.getByTestId('generate-template-storyboard-grid-25')).toHaveTextContent('25-panel storyboard');
    expect(screen.getByTestId('generate-template-storyboard-grid-25')).toHaveTextContent('A 5×5 sequence of one story, for turning into a video');
    expect(screen.queryByTestId('generate-template-costume-sheet')).toBeNull();
  });

  it('lists the video templates under their goal in a video panel', () => {
    open('video');
    expect(screen.getByTestId('generate-template-goal-character')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-template-goal-comics-storyboards')).toBeNull();
    openGoal('character');
    expect(screen.getByTestId('generate-template-single-view-refs-scene')).toBeInTheDocument();
  });

  it('opens on an empty state where the node type has no templates', () => {
    open('audio');
    expect(screen.getByTestId('generate-template-empty')).toHaveTextContent('No templates');
    expect(screen.queryAllByTestId(/^generate-template-goal-/)).toEqual([]);
  });

  it('hands the picked template to the panel', () => {
    const onPick = vi.fn();
    open('image', undefined, onPick);
    openGoal('character');
    fireEvent.click(screen.getByTestId('generate-template-costume-sheet'));
    expect(onPick).toHaveBeenCalledWith('costume-sheet');
  });

  it('shows a template whose model this deployment lacks as unavailable and does not pick it, its goal still opening', () => {
    const onPick = vi.fn();
    open('image', [], onPick);
    expect(screen.getByTestId('generate-template-goal-comics-storyboards')).not.toHaveAttribute('data-disabled');
    openGoal('comics-storyboards');
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
      serveFixture(type);
      const onPick = vi.fn();
      open(type, [{ name: 'final-model' }, { name: 'first-model' }], onPick);
      expect(templateGoalsFor).toHaveBeenCalledWith(type);
      openGoal('character');
      const item = screen.getByTestId('generate-template-fixture-two-step');
      expect(item).toHaveTextContent('Two step');
      expect(item).not.toHaveAttribute('data-disabled');
      fireEvent.click(item);
      expect(onPick).toHaveBeenCalledWith('fixture-two-step');
    },
  );

  it('shows a template as unavailable when a non-anchor generate node’s model is not served', () => {
    serveFixture('image');
    const onPick = vi.fn();
    open('image', [{ name: 'final-model' }], onPick);
    openGoal('character');
    const item = screen.getByTestId('generate-template-fixture-two-step');
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveTextContent('Unavailable');
    fireEvent.click(item);
    expect(onPick).not.toHaveBeenCalled();
  });
});
