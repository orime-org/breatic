// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/**
 * Self-drawn, monochrome (black/white/grey via `currentColor`) marks for the
 * model picker — one per generatable-model vendor, each EVOKING the vendor's
 * real logo (researched 2026-07-09) rather than reproducing the trademarked
 * artwork:
 *   - `midjourney`  → a sailboat (Midjourney's stylised two-sail mark).
 *   - `nano-banana` → a banana (Google Gemini's "🍌" image branding).
 *   - `seedream`    → uneven vertical bars (ByteDance Seed's bar logomark).
 * The picker only shows generation models (t2i / i2i); every one of their
 * config `icon` names is covered here — there is deliberately NO generic
 * "unknown model" fallback (user 2026-07-09).
 */
const MARKS: Readonly<Record<string, React.JSX.Element>> = {
  // Two billowing sails above a hull.
  midjourney: (
    <>
      <path d='M11 3.2 11 13 5.4 13C6.4 9 8.4 5.4 11 3.2Z' />
      <path d='M12.6 6 12.6 13 17.8 13C17 10 15.2 7.4 12.6 6Z' />
      <path d='M3.6 15 20.4 15 17.8 19.6 6.2 19.6Z' />
    </>
  ),
  // A banana crescent.
  'nano-banana': (
    <path d='M5.6 4.7C5 11 9.2 16.6 16.7 17.7 18.2 17.9 18.6 16.5 17.2 16 11.7 13.9 9 9.6 8.1 4.6 7.8 3.2 6 3.3 5.6 4.7Z' />
  ),
  // Four uneven vertical bars (equaliser-style), evoking ByteDance Seed.
  seedream: (
    <>
      <rect x='3.4' y='9' width='3' height='11' rx='1' />
      <rect x='8.5' y='4' width='3' height='16' rx='1' />
      <rect x='13.6' y='11' width='3' height='9' rx='1' />
      <rect x='18' y='6.5' width='2.6' height='13.5' rx='1' />
    </>
  ),
};

/** The icon names this registry covers — the generatable-model vendors. */
export const MODEL_ICON_NAMES: readonly string[] = Object.keys(MARKS);

interface ModelIconProps {
  /** The model's config `icon` name (may be absent on a malformed catalog entry). */
  name: string | undefined;
  /** Sizing / colour classes (the picker passes `h-4 w-4` etc.). */
  className?: string;
}

/**
 * Renders the brand mark for a model's `icon` name, or nothing when the name is
 * absent or unmapped (no fallback icon — a genuine model always has a mark; a
 * miss is a config bug to fix, not a case to paper over). The mark inherits the
 * current text colour, so the picker's `text-*` class drives its black/white/grey.
 * @param root0 - Component props.
 * @param root0.name - The model's config icon name.
 * @param root0.className - Sizing / colour classes forwarded to the svg.
 * @returns The brand mark svg, or null.
 */
export function ModelIcon({
  name,
  className,
}: ModelIconProps): React.JSX.Element | null {
  const mark = name ? MARKS[name] : undefined;
  if (!mark) return null;
  return (
    <svg
      data-testid={`model-icon-${name}`}
      viewBox='0 0 24 24'
      fill='currentColor'
      aria-hidden='true'
      className={className}
    >
      {mark}
    </svg>
  );
}
