// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A styled template's row in the template menu (inner#1817, CAP-10) opens a
 * third level listing its style set: grouped under the set's categories when
 * it has them, as a two-column thumbnail grid when it has thumbnails; the
 * words arrive on demand, so the level shows a loading row until then and a
 * refresh hint when they fail. Picking a style applies the template with it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mergeLocaleMessages,
  setLocaleMessages,
  templateGoalsFor,
  templateStylesOf,
  type GenerationTemplate,
  type TemplateStyleSet,
} from '@breatic/shared';
import en from '@locales/en.json';

vi.mock('@breatic/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@breatic/shared')>();
  return { ...actual, templateGoalsFor: vi.fn(actual.templateGoalsFor), templateStylesOf: vi.fn(actual.templateStylesOf) };
});

let settle: (ok: boolean) => void = () => {};
vi.mock('@web/spaces/canvas/generate/template-style-messages', () => ({
  ensureTemplateStyleMessages: vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; })),
}));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { TemplateMenu } from '@web/spaces/canvas/generate/TemplateMenu';

const MODEL = 'fixture-model';

const STYLED: GenerationTemplate = {
  id: 'fixture-styled',
  anchor: 'still',
  styles: 'film-styles',
  nodes: [{ key: 'still', role: 'generate', type: 'image', mode: 'i2i', model: MODEL, params: {}, styleWords: 'still' }],
  edges: [],
  inputs: [],
  steps: [],
  agentNote: 'a fixture',
  goal: 'character',
  triggers: { asks: ['a fixture'], offerWhen: [] },
};

/** A small set with categories and thumbnails, standing in for the film styles. */
const GROUPED: TemplateStyleSet = {
  id: 'film-styles',
  categories: ['painting', 'print'],
  styles: [{ id: 'oil', category: 'painting' }, { id: 'woodcut', category: 'print' }],
  parts: ['still'],
  thumbnails: true,
};

/** A set with neither categories nor thumbnails. */
const PLAIN: TemplateStyleSet = { id: 'film-styles', styles: [{ id: 'flash' }, { id: 'invert' }], parts: ['still'], thumbnails: false };

beforeEach(() => {
  vi.mocked(templateGoalsFor).mockReturnValue([{ goal: 'character', templates: [STYLED] }]);
  setLocaleMessages('en', {
    ...en,
    canvas: { ...en.canvas, template: { ...en.canvas.template, 'fixture-styled': { name: 'Styled', description: 'A styled fixture' } } },
  } as Record<string, unknown>);
});

afterEach(() => {
  vi.mocked(templateGoalsFor).mockReset();
  vi.mocked(templateStylesOf).mockReset();
  setLocaleMessages('en', en as Record<string, unknown>);
});

/**
 * Renders the menu, opens it, the goal and the styled template's row.
 * @param set - The style set the fixture template names.
 * @param onPick - The pick handler.
 * @returns Nothing.
 */
function openStyles(set: TemplateStyleSet, onPick: (id: string, style?: string) => void = () => {}): void {
  vi.mocked(templateStylesOf).mockReturnValue(set);
  render(
    <TooltipProvider>
      <TemplateMenu nodeType='image' models={[{ name: MODEL }]} onPick={(t, style) => onPick(t.id, style)} />
    </TooltipProvider>,
  );
  fireEvent.keyDown(screen.getByTestId('generate-template-trigger'), { key: 'Enter' });
  fireEvent.keyDown(screen.getByTestId('generate-template-goal-character'), { key: 'ArrowRight' });
  fireEvent.keyDown(screen.getByTestId('generate-template-fixture-styled'), { key: 'ArrowRight' });
}

/**
 * Lets the style words arrive, merged in, or fail.
 * @param ok - Whether they arrived.
 * @returns Nothing.
 */
async function arrive(ok: boolean): Promise<void> {
  if (ok) {
    mergeLocaleMessages('en', {
      canvas: {
        template: {
          styleSet: {
            'film-styles': {
              category: { painting: 'Painting', print: 'Print' },
              style: { oil: { name: 'Oil' }, woodcut: { name: 'Woodcut' }, flash: { name: 'Flash' }, invert: { name: 'Invert' } },
            },
          },
        },
      },
    });
  }
  await act(async () => {
    settle(ok);
    await Promise.resolve();
  });
}

describe('TemplateMenu with a styled template', () => {
  it('shows a loading row until the style words arrive', () => {
    openStyles(GROUPED);
    expect(screen.getByTestId('generate-template-styles-loading')).toHaveTextContent(en.common.loading);
  });

  it('groups the styles under their categories with a thumbnail each once the words arrive', async () => {
    openStyles(GROUPED);
    await arrive(true);
    expect(screen.queryByTestId('generate-template-styles-loading')).toBeNull();
    expect(screen.getByTestId('generate-template-style-category-painting')).toHaveTextContent('Painting');
    expect(screen.getByTestId('generate-template-style-category-print')).toHaveTextContent('Print');
    const oil = screen.getByTestId('generate-template-style-oil');
    expect(oil).toHaveTextContent('Oil');
    expect(oil.querySelector('img')?.getAttribute('src')).toBe('/template-styles/film-styles/oil.webp');
  });

  it('lists a set with no categories and no thumbnails as one column of names', async () => {
    openStyles(PLAIN);
    await arrive(true);
    expect(screen.queryAllByTestId(/^generate-template-style-category-/)).toEqual([]);
    expect(screen.getByTestId('generate-template-style-flash')).toHaveTextContent('Flash');
    expect(screen.getByTestId('generate-template-style-flash').querySelector('img')).toBeNull();
  });

  it('applies the template with the style picked', async () => {
    const onPick = vi.fn();
    openStyles(GROUPED, onPick);
    await arrive(true);
    fireEvent.click(screen.getByTestId('generate-template-style-woodcut'));
    expect(onPick).toHaveBeenCalledWith('fixture-styled', 'woodcut');
  });

  it('applies nothing when the styled template\'s own row is chosen', () => {
    const onPick = vi.fn();
    openStyles(GROUPED, onPick);
    fireEvent.keyDown(screen.getByTestId('generate-template-fixture-styled'), { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('asks the user to refresh, showing no keys, when the style words fail to arrive', async () => {
    openStyles(GROUPED);
    await arrive(false);
    expect(screen.getByTestId('generate-template-styles-failed')).toHaveTextContent(en.canvas.template.styleLoadFailed);
    expect(screen.queryByTestId('generate-template-style-oil')).toBeNull();
  });
});
