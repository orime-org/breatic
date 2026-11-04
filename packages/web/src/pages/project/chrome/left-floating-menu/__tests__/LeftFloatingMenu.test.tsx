// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LeftFloatingMenu } from '@web/pages/project/chrome/left-floating-menu/LeftFloatingMenu';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

function setup(disabled = false, armedTool?: 'comment') {
  const onPick = vi.fn();
  const onCreateNode = vi.fn();
  render(
    <TooltipProvider>
      <LeftFloatingMenu
        onPick={onPick}
        onCreateNode={onCreateNode}
        disabled={disabled}
        armedTool={armedTool}
      />
    </TooltipProvider>,
  );
  return { onPick, onCreateNode };
}

describe('LeftFloatingMenu', () => {
  it('renders the nav landmark', () => {
    setup();
    expect(screen.getByTestId('left-floating-menu')).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    setup();
    await expectNoA11yViolations(document.body);
  });

  it('exposes the three creation tools and, below the divider, only the shortcuts button', () => {
    setup();
    const ids = [...screen.getByTestId('left-floating-menu').querySelectorAll('[data-testid^="tool-"]')].map(
      (el) => el.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['tool-nodes', 'tool-upload', 'tool-comment', 'tool-shortcuts']);
    expect(screen.getByTestId('left-menu-divider').nextElementSibling).toBe(
      screen.getByTestId('tool-shortcuts'),
    );
  });

  it('the shortcuts button opens the canvas shortcuts dialog', async () => {
    const user = userEvent.setup();
    const { onPick } = setup();
    await user.click(screen.getByTestId('tool-shortcuts'));
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByTestId('shortcut-row-undo')).toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('closing the shortcuts dialog with Escape returns focus to the shortcuts button', async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByTestId('tool-shortcuts');
    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('viewer (disabled): the shortcuts button stays usable and shows only the rows a viewer can use', async () => {
    const user = userEvent.setup();
    setup(true);
    const trigger = screen.getByTestId('tool-shortcuts');
    expect(trigger).toBeEnabled();
    expect(screen.getByTestId('tool-upload')).toBeDisabled();
    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(screen.getByTestId('shortcut-row-pan')).toBeInTheDocument();
    expect(screen.queryByTestId('shortcut-row-undo')).toBeNull();
  });

  it('lights the comment button while the annotation tool is armed', () => {
    // The tool is a mode, not a fire-and-forget action: until the next canvas
    // click lands the note, the button has to say it is the one that is on.
    // Same pressed visual the viewport toolbar's toggles use.
    setup(false, 'comment');
    const button = screen.getByTestId('tool-comment');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button.className).toContain('bg-foreground');
    expect(button.className).toContain('text-background');
  });

  it('leaves the comment button idle while nothing is armed', () => {
    setup();
    const button = screen.getByTestId('tool-comment');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button.className).not.toContain('bg-foreground');
  });

  it('renders the divider separating the two zones', () => {
    setup();
    expect(screen.getByTestId('left-menu-divider')).toBeInTheDocument();
  });

  it('clicking a tool calls onPick with its id', async () => {
    const user = userEvent.setup();
    const { onPick } = setup();
    await user.click(screen.getByTestId('tool-upload'));
    expect(onPick).toHaveBeenCalledWith('upload');
  });

  it('node-library entry carries the permanent featured highlight', () => {
    setup();
    // Featured = solid foreground swap. The class set is documented in
    // LeftFloatingMenu.tsx; we assert the marker class that drives it
    // so the visual stays anchored to the node-library entry.
    expect(screen.getByTestId('tool-nodes').className).toContain(
      'bg-foreground',
    );
  });

  it('no fire-and-forget button (upload / shortcuts) carries a featured / pressed visual', () => {
    setup();
    // These stay pure actions: one press, one thing happens, nothing pinned.
    // The comment button left this family on 2026-09-14 — it arms a mode, so
    // it is the one button here that has something to be pressed ABOUT (see
    // the two armed cases above, and design §6.4.1).
    for (const id of ['upload', 'shortcuts']) {
      const btn = screen.getByTestId(`tool-${id}`);
      expect(btn.hasAttribute('aria-pressed')).toBe(false);
      expect(btn.className).not.toContain('bg-foreground');
    }
  });

  it('clicking action buttons does not leave behind any aria-pressed mutation', async () => {
    const user = userEvent.setup();
    setup();
    const upload = screen.getByTestId('tool-upload');
    await user.click(upload);
    // Still no aria-pressed attribute after click — pure action, no
    // pinned / activated state survives the click.
    expect(upload.hasAttribute('aria-pressed')).toBe(false);
  });

  it('node-library button opens a dropdown listing the 4 creatable node types', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('tool-nodes'));
    expect(await screen.findByTestId('create-node-text')).toBeInTheDocument();
    expect(screen.getByTestId('create-node-image')).toBeInTheDocument();
    expect(screen.getByTestId('create-node-audio')).toBeInTheDocument();
    expect(screen.getByTestId('create-node-video')).toBeInTheDocument();
  });

  it('picking a node type fires onCreateNode with that type', async () => {
    const user = userEvent.setup();
    const { onCreateNode } = setup();
    await user.click(screen.getByTestId('tool-nodes'));
    await user.click(await screen.findByTestId('create-node-audio'));
    expect(onCreateNode).toHaveBeenCalledWith('audio');
  });

  it('closing the node-library dropdown returns focus to the trigger without re-popping its tooltip', async () => {
    // C mechanism: focus DOES return to the menu button on close (ARIA menu-
    // button requirement — we don't block it); the trigger's `onFocusCapture`
    // stops the tooltip from opening on that programmatic refocus, so no
    // stray tooltip pops. (The tooltip-not-popping half is also covered by
    // the real-browser smoke; jsdom verifies the focus return here.)
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByTestId('tool-nodes');
    await user.click(trigger);
    await screen.findByTestId('create-node-text');
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(trigger);
    expect(
      document.querySelector(
        '[data-state="instant-open"],[data-state="delayed-open"]',
      ),
    ).toBeNull();
  });

  it('viewer (disabled): the node-library button does not open a create menu', async () => {
    const user = userEvent.setup();
    setup(true);
    await user.click(screen.getByTestId('tool-nodes'));
    expect(screen.queryByTestId('create-node-text')).toBeNull();
  });

  // Reference-pick concealment (batch-2 item 13): during a pick the menu
  // slides out through the LEFT edge but STAYS MOUNTED, and goes `inert` so
  // keyboard users cannot tab into an off-screen control. The slide-out
  // translate must COMPOSE with the menu's own -translate-y-1/2 vertical
  // centering (replacing it would also fling the menu vertically).
  it('concealed: slides out via -translate-x, keeps vertical centering, stays mounted, inert', () => {
    render(
      <TooltipProvider>
        <LeftFloatingMenu onPick={vi.fn()} onCreateNode={vi.fn()} concealed />
      </TooltipProvider>,
    );
    const nav = screen.getByTestId('left-floating-menu');
    expect(nav).toBeInTheDocument();
    expect(nav.className).toContain('-translate-x-24');
    expect(nav.className).toContain('-translate-y-1/2');
    expect(nav.className).toContain('transition-transform');
    expect(nav.hasAttribute('inert')).toBe(true);
  });

  it('not concealed: on-screen, not inert, ready to animate', () => {
    setup();
    const nav = screen.getByTestId('left-floating-menu');
    expect(nav.className).not.toContain('-translate-x-24');
    expect(nav.className).toContain('transition-transform');
    expect(nav.hasAttribute('inert')).toBe(false);
  });
});
