import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LeftFloatingMenu } from '@/pages/project/chrome/left-floating-menu/LeftFloatingMenu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { expectNoA11yViolations } from '@/test-utils/a11y';

function setup() {
  const onPick = vi.fn();
  render(
    <TooltipProvider>
      <LeftFloatingMenu onPick={onPick} />
    </TooltipProvider>,
  );
  return { onPick };
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

  it('exposes the 6 mock-spec tools (3 upper + 3 placeholder lower)', () => {
    setup();
    expect(screen.getByTestId('tool-nodes')).toBeInTheDocument();
    expect(screen.getByTestId('tool-upload')).toBeInTheDocument();
    expect(screen.getByTestId('tool-comment')).toBeInTheDocument();
    expect(screen.getByTestId('tool-asset-group')).toBeInTheDocument();
    expect(screen.getByTestId('tool-help')).toBeInTheDocument();
    expect(screen.getByTestId('tool-feedback')).toBeInTheDocument();
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

  it('no action button (upload / comment / placeholders) carries a featured / pressed visual', () => {
    setup();
    // Pure action buttons must never enter a pressed or pinned state —
    // not via aria-pressed (we removed the prop entirely) and not via
    // any active background class.
    for (const id of ['upload', 'comment', 'asset-group', 'help', 'feedback']) {
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
});
