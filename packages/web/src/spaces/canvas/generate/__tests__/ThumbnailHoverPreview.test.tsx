// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import {
  render as baseRender,
  screen,
  fireEvent,
} from '@testing-library/react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { ThumbnailHoverPreview } from '@web/spaces/canvas/generate/ThumbnailHoverPreview';

// The component inherits the ONE app-level TooltipProvider at runtime (App.tsx)
// and no longer nests its own (single-provider mandate). Supply that provider
// here — the real Radix one, since these tests assert the Radix trigger stamps
// `data-state` (a passthrough mock wouldn't).
const render = (
  ...args: Parameters<typeof baseRender>
): ReturnType<typeof baseRender> =>
  // wrapper option (not a manual <TooltipProvider> wrap) so a later rerender()
  // keeps the provider too — testing-library re-applies the wrapper on rerender.
  baseRender(args[0], { ...args[1], wrapper: TooltipProvider });

// A Radix TooltipTrigger stamps `data-state` on its (asChild) trigger element;
// a short-circuited preview renders the child untouched. So `data-state` present
// ⇔ the tooltip wrapper mounted.
describe('ThumbnailHoverPreview — mount gate', () => {
  it('renders NO tooltip when there is no src/text/emptyHint/resolver (unhandled modality — batch-5 adversarial finding 2)', () => {
    const { getByTestId } = render(
      <ThumbnailHoverPreview alt='x'>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    // No preview content of any kind → the trigger is rendered unchanged, so an
    // audio / 3d / web / legacy chip gets no empty tooltip box on hover.
    expect(getByTestId('chip')).not.toHaveAttribute('data-state');
  });

  it('mounts the tooltip for a text chip (live resolver present)', () => {
    const { getByTestId } = render(
      <ThumbnailHoverPreview alt='x' resolveOnOpen={() => ({ text: 'hi' })}>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    expect(getByTestId('chip')).toHaveAttribute('data-state');
  });

  it('mounts the tooltip for the static rail path (attr-backed text / emptyHint)', () => {
    const { getByTestId } = render(
      <ThumbnailHoverPreview alt='x' text='body'>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    expect(getByTestId('chip')).toHaveAttribute('data-state');
  });

  it('mounts the tooltip for a visual chip with only an empty hint (image with no thumbnail)', () => {
    const { getByTestId } = render(
      <ThumbnailHoverPreview alt='x' emptyHint='not yet filled'>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    expect(getByTestId('chip')).toHaveAttribute('data-state');
  });

  it('seeds the live resolver at mount so it never renders before resolving', () => {
    // The resolver runs once at mount (state initializer) — proves the preview is
    // populated before the first open, not left undefined for a frame.
    const resolve = vi.fn(() => ({ text: 'seeded' }));
    render(
      <ThumbnailHoverPreview alt='x' resolveOnOpen={resolve}>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    expect(resolve).toHaveBeenCalled();
  });
});

// #1798: an image chip's hover preview greys out when t2i will ignore it, but the
// chip is a ProseMirror NodeView that does NOT re-render on a mode toggle — a
// `dimmed` captured at NodeView render froze at insert time, so switching t2i→i2i
// left the preview greyed. `resolveDimmed` is read live at hover-open instead.
describe('ThumbnailHoverPreview — live-at-open dim (#1798)', () => {
  it('seeds resolveDimmed at mount (reads the live getter, not a captured prop)', () => {
    const resolveDimmed = vi.fn(() => true);
    render(
      <ThumbnailHoverPreview alt='pic' src='a.png' resolveDimmed={resolveDimmed}>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    expect(resolveDimmed).toHaveBeenCalled();
  });

  it('re-resolves the dim on each open so a t2i→i2i toggle clears the grey', async () => {
    let hideImages = true; // t2i: the image reference is ignored → greyed.
    render(
      <ThumbnailHoverPreview
        alt='pic'
        src='a.png'
        resolveDimmed={() => hideImages}
      >
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    const trigger = screen.getByTestId('chip');
    // Radix opens a tooltip on trigger focus (no hover delay). It renders the
    // preview twice (a visible copy + an a11y copy), both driven by the same
    // component state, so assert on every match. In t2i → greyed.
    fireEvent.focus(trigger);
    const dimmed = await screen.findAllByAltText('pic');
    expect(dimmed.length).toBeGreaterThan(0);
    dimmed.forEach((img) => expect(img.className).toContain('opacity-50'));
    // Close, switch to i2i, re-open → the dim is re-resolved live and gone.
    fireEvent.blur(trigger);
    hideImages = false;
    fireEvent.focus(trigger);
    const lit = await screen.findAllByAltText('pic');
    lit.forEach((img) => expect(img.className).not.toContain('opacity-50'));
  });
});

// #1796 (hover follow-up): the preview mis-positioned because the shadcn Tooltip
// does NOT portal (unlike the Popover pickers), so it rendered INLINE inside the
// ReactFlow CSS transform — a real-browser measurement showed the content landing
// 207px left of its chip. Portaling it out of the transform (to body) anchors it
// to the chip. avoidCollisions={false} keeps a following preview from flipping.
describe('ThumbnailHoverPreview — portals out of the canvas transform (#1796 hover)', () => {
  it('renders the open preview OUTSIDE the component container (portaled to body)', async () => {
    const { container, getByTestId } = render(
      <ThumbnailHoverPreview src='a.png' alt='pic'>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    fireEvent.focus(getByTestId('chip'));
    await screen.findAllByAltText('pic'); // wait for the tooltip to open
    // Portaled: the positioned Popper wrapper is under document.body, NOT inside
    // the component's own container (which, in the app, sits inside the ReactFlow
    // transform that displaced the inline tooltip). Same reason the pickers portal.
    expect(
      container.querySelector('[data-radix-popper-content-wrapper]'),
    ).toBeNull();
    expect(
      document.body.querySelector('[data-radix-popper-content-wrapper]'),
    ).not.toBeNull();
  });
});
