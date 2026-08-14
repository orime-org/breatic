// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a slot tool shows for what it holds (#1946).
 *
 * A filled slot covers its button with the pick: the thumbnail when one
 * exists, otherwise the asset node's own icon. Never a label in the filled
 * state — the label belongs to the empty state, where it says what the slot
 * wants. Before this, the button body read only `thumbnail`, so audio (which
 * has no picture by nature) and a coverless video rendered EXACTLY the empty
 * state while holding a pick: same icon, same label, same html, differing only
 * by a 16x16 ✕ badge (真机 2026-08-14).
 *
 * `HoverPreview` is stubbed to expose its props: the claim under test is what
 * the slot DECLARES it holds, and asserting on a rendered MediaPlayer would be
 * asserting on HoverPreview's own behaviour, which has its own tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AudioLines, UserRound } from 'lucide-react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { SlotTool, ToggleTool } from '@web/spaces/canvas/generate/generate-tools';
import * as nodeIcon from '@web/spaces/canvas/lib/node-icon';

vi.mock('@web/spaces/canvas/nodes/_shared/HoverPreview', () => ({
  HoverPreview: ({
    kind,
    src,
    poster,
    followCanvas,
    children,
  }: {
    kind: string;
    src?: string;
    poster?: string;
    followCanvas?: boolean;
    children: React.ReactNode;
  }): React.JSX.Element => (
    <div
      data-testid='slot-preview'
      data-kind={kind}
      data-src={src ?? ''}
      data-poster={poster ?? ''}
      data-follow-canvas={followCanvas === true ? 'yes' : 'no'}
    >
      {children}
    </div>
  ),
}));

/**
 * Watches the icon resolver the reference rail uses, keeping its real return
 * value — the point is WHICH function the slot reaches, not what it renders.
 */
const getNodeIconSpy = vi.spyOn(nodeIcon, 'getNodeIcon');

beforeEach(() => {
  getNodeIconSpy.mockClear();
});

/**
 * Renders one slot tool with no-op defaults, overridable per test.
 *
 * Wrapped in the app-level TooltipProvider the way the real panels are —
 * the tools carry no provider of their own, so a bare Radix Tooltip throws.
 * @param overrides - Props overriding the defaults.
 * @returns The render result.
 */
function slot(
  overrides: Partial<React.ComponentProps<typeof SlotTool>> = {},
): ReturnType<typeof render> {
  return render(
    <TooltipProvider delayDuration={100}>
      <SlotTool
        testId='slot'
        thumbnailTestId='slot-thumb'
        clearTestId='slot-clear'
        Icon={AudioLines}
        onPick={() => {}}
        onClear={() => {}}
        active={false}
        disabled={false}
        clearLabel='Remove driving audio'
        label='Driving audio'
        tip='Pick an audio clip'
        {...overrides}
      />
    </TooltipProvider>,
  );
}

/** The pick an audio slot holds: an asset URL and no picture of its own. */
const AUDIO_PICK = { kind: 'audio', url: 'https://cdn/voice.m4a' } as const;
/** A coverless video: an asset an `<img>` cannot paint, and no poster either. */
const COVERLESS_VIDEO = { kind: 'video', url: 'https://cdn/clip.mp4' } as const;
/** An image pick, whose asset IS its picture. */
const IMAGE_PICK = {
  kind: 'image',
  url: 'https://cdn/face.png',
  thumbnail: 'https://cdn/face.png',
} as const;

/**
 * The lucide class the component stamps on its rendered icon
 * (`lucide-music`, `lucide-video`, …) — the observable identity of an icon.
 * @param root - Where to look.
 * @returns The lucide-* class names found, in DOM order.
 */
function iconClasses(root: HTMLElement): string[] {
  return [...root.querySelectorAll('svg')].flatMap((svg) =>
    [...svg.classList].filter((c) => c.startsWith('lucide-')),
  );
}

describe('SlotTool — a filled slot covers its button with what it holds', () => {
  it('covers an audio pick with the audio node icon, and drops the label', () => {
    const { container } = slot({ pick: AUDIO_PICK });
    // The asset node's own icon, not the slot's own AudioLines: the rail
    // renders the same glyph for the same node, and #1946 exists to make the
    // two agree.
    expect(iconClasses(container)).toContain('lucide-music');
    // `toBeVisible` is useless here: it reads computed style, and jsdom loads
    // no Tailwind, so `invisible` produces no `visibility: hidden` and every
    // implementation would pass. The class itself is the observable claim.
    expect(screen.getByText('Driving audio').className).toContain('invisible');
  });

  it('covers a coverless video pick with the video node icon', () => {
    const { container } = slot({ pick: COVERLESS_VIDEO, Icon: UserRound });
    expect(iconClasses(container)).toContain('lucide-video');
  });

  it('still paints the thumbnail when the pick has one', () => {
    slot({ pick: IMAGE_PICK });
    const img = screen.getByTestId('slot-thumb');
    expect(img).toHaveAttribute('src', 'https://cdn/face.png');
  });

  it('shows the slot OWN icon plus a visible label while empty', () => {
    const { container } = slot();
    expect(iconClasses(container)).toContain('lucide-audio-lines');
    expect(screen.getByText('Driving audio')).toBeVisible();
  });

  it('keeps the placeholder icon and label IN THE DOM when filled', () => {
    // The footprint is held by the icon + label laying out invisibly beneath
    // the cover. Deleting them is the regression this pins: the button's class
    // string carries no width or height at all, so asserting on "size classes"
    // would pass either way (Gate 1).
    slot({ pick: AUDIO_PICK });
    const label = screen.getByText('Driving audio');
    expect(label).toBeInTheDocument();
    expect(label.className).toContain('invisible');
    // The slot's own icon holds its half of the footprint the same way.
    const own = document.querySelector('svg.lucide-audio-lines');
    expect(own).not.toBeNull();
    expect(own?.getAttribute('class')).toContain('invisible');
  });

  it('takes the filled icon from the same source the reference rail uses', () => {
    // Comparing the rendered glyph proves nothing: the rival table
    // (MODALITY_ICONS, the subject of #1954) maps audio to Music too, so a slot
    // wired to it renders an identical note. Gate 2 swapped the source and this
    // file stayed green. So watch the FUNCTION: the rail resolves its icon
    // through getNodeIcon, and the slot must reach the same one.
    slot({ pick: AUDIO_PICK });
    expect(getNodeIconSpy).toHaveBeenCalledWith('audio');
  });

  it('asks getNodeIcon for the video form when it holds a video', () => {
    slot({ pick: COVERLESS_VIDEO });
    expect(getNodeIconSpy).toHaveBeenCalledWith('video');
  });

  it('never asks for an icon while empty — there is nothing held', () => {
    slot();
    expect(getNodeIconSpy).not.toHaveBeenCalled();
  });
});

describe('SlotTool — the filled slot joins the shared hover preview (#1814)', () => {
  it('previews an audio pick as playable audio, following the canvas', () => {
    slot({ pick: AUDIO_PICK });
    const preview = screen.getByTestId('slot-preview');
    expect(preview).toHaveAttribute('data-kind', 'audio');
    expect(preview).toHaveAttribute('data-src', 'https://cdn/voice.m4a');
    expect(preview).toHaveAttribute('data-follow-canvas', 'yes');
  });

  it('previews a video pick with its cover as the poster', () => {
    slot({
      pick: {
        kind: 'video',
        url: 'https://cdn/clip.mp4',
        thumbnail: 'https://cdn/cover.jpg',
      },
    });
    const preview = screen.getByTestId('slot-preview');
    expect(preview).toHaveAttribute('data-kind', 'video');
    expect(preview).toHaveAttribute('data-src', 'https://cdn/clip.mp4');
    expect(preview).toHaveAttribute('data-poster', 'https://cdn/cover.jpg');
  });

  it('opens no preview while the slot is empty — there is nothing to preview', () => {
    slot();
    expect(screen.queryByTestId('slot-preview')).toBeNull();
  });

  it('lets the preview REPLACE the tooltip, not sit beside it', () => {
    // Two floating cards on one trigger would open together. The rail carries
    // no tooltip for the same reason. Radix marks a tooltip trigger with
    // `data-state`; a filled slot must not be one.
    slot({ pick: AUDIO_PICK });
    expect(screen.getByTestId('slot')).not.toHaveAttribute('data-state');
  });

  it('keeps the tooltip while empty — that is what says WHAT to pick', () => {
    slot();
    expect(screen.getByTestId('slot')).toHaveAttribute('data-state');
  });
});

describe('SlotTool — a running pick reads on the button while filled', () => {
  it('rings the button when the pick is running on a filled slot', () => {
    // The white-fill active style hides behind the cover, so a filled slot
    // that is re-picking says so with a ring instead (A10).
    slot({ pick: AUDIO_PICK, active: true });
    expect(classes(screen.getByTestId('slot'))).toContain('ring-foreground');
  });

  it('does not ring a filled slot that is idle', () => {
    slot({ pick: AUDIO_PICK });
    expect(classes(screen.getByTestId('slot'))).not.toContain('ring-foreground');
  });
});

/**
 * The Tailwind class list of an element, as discrete tokens.
 *
 * A regex over the whole string cannot tell `border` from `border-border`:
 * `\b` treats the hyphen as a word boundary, so the colour-only utility
 * satisfies it while rendering no border at all (preflight sets border-width
 * to 0). Gate 2 dropped the width class and this file stayed green.
 * @param el - The element to read.
 * @returns Its class names.
 */
function classes(el: HTMLElement): string[] {
  return [...el.classList];
}

describe('SlotTool / ToggleTool — the toolbar buttons carry a 1px border', () => {
  it('borders a slot tool with the WIDTH utility, not just the colour', () => {
    slot();
    const c = classes(screen.getByTestId('slot'));
    expect(c).toContain('border');
    expect(c).toContain('border-border');
  });

  it('borders a filled slot too', () => {
    slot({ pick: AUDIO_PICK });
    expect(classes(screen.getByTestId('slot'))).toContain('border');
  });

  it('borders a toggle tool', () => {
    render(
      <TooltipProvider delayDuration={100}>
        <ToggleTool
          testId='toggle'
          label='Reference'
          tip='Pick a reference'
          Icon={AudioLines}
          onClick={() => {}}
          active={false}
        />
      </TooltipProvider>,
    );
    const c = classes(screen.getByTestId('toggle'));
    expect(c).toContain('border');
    expect(c).toContain('border-border');
  });
});
