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

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AudioLines, UserRound } from 'lucide-react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { SlotTool, ToggleTool } from '@web/spaces/canvas/generate/generate-tools';
import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';

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
    expect(screen.queryByText('Driving audio')).not.toBeVisible();
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
    expect(label).not.toBeVisible();
  });

  it('takes the filled icon from the same source the reference rail uses', () => {
    // Not "both happen to render a music note today": the rail resolves its
    // icon through getNodeIcon, and this pins the slot to that same function.
    const { container } = slot({ pick: AUDIO_PICK });
    const RailIcon = getNodeIcon('audio');
    const { container: railLike } = render(<RailIcon />);
    expect(iconClasses(container)).toContain(iconClasses(railLike)[0]);
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
});

describe('SlotTool / ToggleTool — the toolbar buttons carry a 1px border', () => {
  it('borders a slot tool', () => {
    slot();
    expect(screen.getByTestId('slot').className).toMatch(/\bborder\b/);
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
    expect(screen.getByTestId('toggle').className).toMatch(/\bborder\b/);
  });
});
