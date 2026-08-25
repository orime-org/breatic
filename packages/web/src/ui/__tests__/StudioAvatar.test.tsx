// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * StudioAvatar — the one avatar used everywhere a studio is shown.
 *
 * The rules under test are the ones that were inconsistent before this
 * component existed (design §3.2): shape follows `studios.type` (personal =
 * round, team = squared) rather than where it is used, initials are always
 * two characters, and the size comes from the `--avatar-*` scale.
 *
 * Radix's Avatar preloads through `new window.Image()` and only mounts the
 * `<img>` once that fires `load` — which never happens in jsdom. The image
 * path is therefore driven by a stubbed loader here rather than left
 * untested, since "the avatar actually shows the image" is acceptance item
 * A1 and skipping it would leave the whole point of the component unverified.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { StudioAvatar } from '@web/ui/StudioAvatar';

/**
 * Replace `window.Image` with a stub that resolves the preload immediately,
 * so Radix's Avatar reaches its `loaded` state and mounts the `<img>`.
 *
 * The shape is dictated by what Radix's `useImageLoadingStatus` actually
 * touches, read from the installed `@radix-ui/react-avatar` dist rather than
 * assumed: it assigns `src`, subscribes through `addEventListener`, and
 * short-circuits to `loaded` when `complete && naturalWidth > 0`. Its `load`
 * handler reads the image back off `event.currentTarget` rather than the
 * closure (1.2 changed this), so the stub hands its listeners a real event
 * shape — a bare `cb()` left that handler dereferencing undefined.
 *
 * The `src` getter is here to make the setter legal, not because anything
 * reads it back: 1.1 guarded with `if (image.src !== src)`, 1.2 assigns
 * unconditionally.
 * @param outcome - Whether the stubbed preload should succeed or fail.
 * @returns A restore function putting the real constructor back.
 */
function stubImageLoading(outcome: 'load' | 'error'): () => void {
  const original = window.Image;
  class StubImage {
    private listeners = new Map<string, Set<(event: { currentTarget: StubImage }) => void>>();
    private currentSrc = '';
    public complete = false;
    public naturalWidth = 0;
    public referrerPolicy = '';
    public crossOrigin: string | null = null;

    public get src(): string {
      return this.currentSrc;
    }

    public set src(value: string) {
      this.currentSrc = value;
      // Async completion mirrors a real network fetch, so the component goes
      // through its `loading` state rather than starting out resolved.
      queueMicrotask(() => {
        if (outcome === 'load') {
          this.complete = true;
          this.naturalWidth = 1;
        }
        for (const cb of this.listeners.get(outcome) ?? [])
          cb({ currentTarget: this });
      });
    }

    public addEventListener(
      type: string,
      cb: (event: { currentTarget: StubImage }) => void,
    ): void {
      const set =
        this.listeners.get(type) ??
        new Set<(event: { currentTarget: StubImage }) => void>();
      set.add(cb);
      this.listeners.set(type, set);
    }

    public removeEventListener(
      type: string,
      cb: (event: { currentTarget: StubImage }) => void,
    ): void {
      this.listeners.get(type)?.delete(cb);
    }
  }
  window.Image = StubImage as unknown as typeof Image;
  return () => {
    window.Image = original;
  };
}

let restoreImage: (() => void) | null = null;

afterEach(() => {
  restoreImage?.();
  restoreImage = null;
});

describe('StudioAvatar — initials fallback', () => {
  // The rule is the one the project member stack already used, kept rather
  // than replaced: a multi-word name takes the first letter of its first and
  // last word, so "Songxiu Lei" reads as SL instead of SO. That carries more
  // information for people's names, and it degrades to the first two
  // characters for single-word names, which is what every other site did.
  it('takes the first and last word initials for a multi-word name', () => {
    render(
      <StudioAvatar
        name='orime studio'
        type='team'
        avatarUrl={null}
        size='md'
      />,
    );
    expect(screen.getByText('OS')).toBeInTheDocument();
  });

  it('ignores the middle words', () => {
    render(
      <StudioAvatar
        name='Ada Byron Lovelace'
        type='personal'
        avatarUrl={null}
        size='md'
      />,
    );
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('takes the first two characters of a single-word name', () => {
    render(
      <StudioAvatar name='orime' type='team' avatarUrl={null} size='md' />,
    );
    expect(screen.getByText('OR')).toBeInTheDocument();
  });

  it('shows the single available character for a one-character name', () => {
    render(
      <StudioAvatar name='x' type='personal' avatarUrl={null} size='md' />,
    );
    expect(screen.getByText('X')).toBeInTheDocument();
  });

  it('tolerates runs of whitespace rather than reading them as words', () => {
    render(
      <StudioAvatar
        name='  orime   studio  '
        type='team'
        avatarUrl={null}
        size='md'
      />,
    );
    expect(screen.getByText('OS')).toBeInTheDocument();
  });

  it('falls back to ? for an empty name instead of an empty circle', () => {
    render(
      <StudioAvatar name='' type='personal' avatarUrl={null} size='md' />,
    );
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('takes the initials from the display name, so a renamed studio re-initials', () => {
    const { rerender } = render(
      <StudioAvatar name='Alpha co' type='team' avatarUrl={null} size='md' />,
    );
    expect(screen.getByText('AC')).toBeInTheDocument();
    rerender(
      <StudioAvatar name='Beta co' type='team' avatarUrl={null} size='md' />,
    );
    expect(screen.getByText('BC')).toBeInTheDocument();
  });
});

describe('StudioAvatar — image', () => {
  // Queried through the DOM rather than by role: an empty `alt` takes the
  // image out of the accessibility tree entirely (it has no `img` role), which
  // is the intent — see the alt test below.
  it('mounts the <img> with the given URL once it loads', async () => {
    restoreImage = stubImageLoading('load');
    render(
      <StudioAvatar
        name='Orime'
        type='team'
        avatarUrl='https://cdn.example/a.webp'
        size='lg'
      />,
    );
    await waitFor(() => {
      expect(document.querySelector('img')).toHaveAttribute(
        'src',
        'https://cdn.example/a.webp',
      );
    });
  });

  it('falls back to initials when the image fails to load', async () => {
    restoreImage = stubImageLoading('error');
    render(
      <StudioAvatar
        name='Orime'
        type='team'
        avatarUrl='https://cdn.example/broken.webp'
        size='lg'
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('OR')).toBeInTheDocument();
    });
    expect(document.querySelector('img')).toBeNull();
  });

  it('gives the image an empty alt — the avatar is decorative beside its name', async () => {
    restoreImage = stubImageLoading('load');
    render(
      <StudioAvatar
        name='Orime'
        type='team'
        avatarUrl='https://cdn.example/a.webp'
        size='lg'
      />,
    );
    // An empty alt keeps it out of the a11y tree as an image with no meaning;
    // every display site renders the studio name next to it.
    await waitFor(() => {
      expect(document.querySelector('img')).toHaveAttribute('alt', '');
    });
  });
});

describe('StudioAvatar — shape follows studios.type', () => {
  it('is round for a personal studio, on BOTH the root and the fallback layer', () => {
    render(
      <StudioAvatar
        name='alice'
        type='personal'
        avatarUrl={null}
        size='md'
        data-testid='avatar'
      />,
    );
    const root = screen.getByTestId('avatar');
    expect(root.className).toContain('rounded-full');
    // Round happens to be the primitive's own default, so this asserts the
    // outcome rather than guarding the wiring — it goes red only if that
    // default changes. The team case below is the one that guards the fix.
    const fallback = screen.getByText('AL');
    expect(fallback.className).toContain('rounded-full');
  });

  it('is squared for a team studio, on BOTH layers', () => {
    render(
      <StudioAvatar
        name='orime'
        type='team'
        avatarUrl={null}
        size='md'
        data-testid='avatar'
      />,
    );
    const root = screen.getByTestId('avatar');
    expect(root.className).toContain('rounded-chrome');
    expect(root.className).not.toContain('rounded-full');
    const fallback = screen.getByText('OR');
    expect(fallback.className).toContain('rounded-chrome');
    expect(fallback.className).not.toContain('rounded-full');
  });

  it('keeps the shape decided by type, not by the caller passing a className', () => {
    // The point of the component is that one studio looks the same in every
    // place; a display site must not be able to round a team studio.
    render(
      <StudioAvatar
        name='orime'
        type='team'
        avatarUrl={null}
        size='md'
        className='shrink-0'
        data-testid='avatar'
      />,
    );
    const root = screen.getByTestId('avatar');
    expect(root.className).toContain('rounded-chrome');
    expect(root.className).toContain('shrink-0');
  });
});

describe('StudioAvatar — size scale', () => {
  it.each([
    ['xs', 'var(--avatar-xs)'],
    ['sm', 'var(--avatar-sm)'],
    ['md', 'var(--avatar-md)'],
    ['lg', 'var(--avatar-lg)'],
    ['xl', 'var(--avatar-xl)'],
  ] as const)('size %s draws from the %s token', (size, cssVar) => {
    render(
      <StudioAvatar
        name='orime'
        type='team'
        avatarUrl={null}
        size={size}
        data-testid='avatar'
      />,
    );
    const root = screen.getByTestId('avatar');
    expect(root.style.width).toBe(cssVar);
    expect(root.style.height).toBe(cssVar);
  });
});

describe('StudioAvatar — colour discipline (A18.1)', () => {
  it('uses the semantic muted tokens, with no literal colour anywhere', () => {
    render(
      <StudioAvatar
        name='orime'
        type='team'
        avatarUrl={null}
        size='md'
        data-testid='avatar'
      />,
    );
    const root = screen.getByTestId('avatar');
    const fallback = screen.getByText('OR');
    expect(fallback.className).toContain('bg-muted');
    expect(fallback.className).toContain('text-muted-foreground');
    // The demo used a per-studio colour; the ratified rule is one muted grey.
    const markup = `${root.className} ${fallback.className} ${root.getAttribute('style') ?? ''}`;
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/rgba?\(/);
  });
});
