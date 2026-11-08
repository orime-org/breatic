// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The bubble bar's buttons name themselves on hover (breatic#1184): every
 * button that runs a command or opens a panel shows its name in a tooltip,
 * greyed or not; a slot that opens a menu on hover shows its menu and nothing
 * else.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  closeShared,
  focusBody,
  mountDocumentEditor,
  openSharedBody,
  selectTextRange,
  waitForBar,
  type HarnessEditor,
} from '@web/spaces/document/__tests__/bubble-bar-harness';

afterEach(() => {
  closeShared();
});

/**
 * Puts the bar up over the first characters of a one-paragraph body.
 * @param html - The body.
 * @param to - How many characters to select from the start.
 * @returns The editor.
 */
async function barOver(html: string, to: number): Promise<HarnessEditor> {
  const editor = openSharedBody(html);
  mountDocumentEditor(editor, false, 'project-1');
  act(() => {
    focusBody(editor);
    selectTextRange(editor, 0, to);
  });
  await waitForBar();
  return editor;
}

/**
 * Whether a control says it cannot be pressed now, whichever way it says so.
 * @param element - The control.
 * @returns True when unavailable.
 */
function unavailable(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true';
}

const ONE_LEVEL = ['bold', 'italic', 'strike', 'underline', 'link', 'code', 'addToAgent', 'comment'] as const;

describe('the bubble bar buttons without a menu', () => {
  it.each(ONE_LEVEL)('%s shows its name on hover, drawn outside the bar', async (id) => {
    const user = userEvent.setup();
    await barOver('<p>hello world</p>', 5);
    const button = screen.getByTestId(`doc-bubble-tool-${id}`);

    await user.hover(button);

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe(button.getAttribute('aria-label'));
    expect(tip.textContent).not.toBe('');
    expect(screen.getByTestId('doc-selection-bubble-bar').contains(tip)).toBe(false);
  });

  it('a greyed button still shows its name, and pressing it changes nothing', async () => {
    const user = userEvent.setup();
    const editor = await barOver('<p><code>hello</code> world</p>', 5);
    const bold = screen.getByTestId('doc-bubble-tool-bold');
    expect(unavailable(bold)).toBe(true);
    // Greyed through aria-disabled: a browser sends an HTML-disabled button no
    // pointer events, so its name could never show. jsdom does not model that;
    // the smoke hovers a greyed button in a real browser.
    expect((bold as HTMLButtonElement).disabled).toBe(false);
    const before = JSON.stringify(editor.document);

    await user.hover(bold);
    const tip = await screen.findByRole('tooltip');
    await user.click(bold);

    expect(tip.textContent).toBe(bold.getAttribute('aria-label'));
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it('pressing a button takes its name away', async () => {
    const user = userEvent.setup();
    await barOver('<p>hello world</p>', 5);
    const bold = screen.getByTestId('doc-bubble-tool-bold');

    await user.hover(bold);
    await screen.findByRole('tooltip');
    await user.click(bold);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('the bubble bar slots that open a menu on hover', () => {
  it.each(['block-type', 'align', 'color', 'ai'])('%s opens its menu and shows no tooltip', async (id) => {
    const user = userEvent.setup();
    await barOver('<p>hello world</p>', 5);

    await user.hover(screen.getByTestId(`doc-bubble-${id}`));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
