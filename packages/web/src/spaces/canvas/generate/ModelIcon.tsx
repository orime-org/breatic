// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/**
 * Self-drawn, monochrome (black/white/grey via `currentColor`) marks for the
 * model picker — one per generatable-model vendor, each EVOKING the vendor's
 * real logo (researched 2026-07-09, audio added 2026-09-03) rather than
 * reproducing the trademarked artwork:
 *   - `midjourney`  → a sailboat (Midjourney's stylised two-sail mark).
 *   - `nano-banana` → a banana (Google Gemini's "🍌" image branding).
 *   - `seedream`    → uneven vertical bars (ByteDance Seed's bar logomark).
 *   - `elevenlabs`  → two upright bars (ElevenLabs' own "11" mark).
 *   - `fish-audio`  → a fish (Fish Audio's name and mark).
 *   - `qwen`        → a microphone: reproducing Alibaba Qwen's wordmark would
 *     be reproducing the trademark itself, so its mark names what the model
 *     does instead.
 *   - `sonilo`      → a sound spreading from a point, for the same reason.
 * The picker shows generation models across every mode the panels offer —
 * t2i / i2i on the image panel, tts / voice_clone / sfx on the audio one —
 * and every `icon` name their configs state is covered here, since there is
 * deliberately NO generic "unknown model" fallback (user 2026-07-09). A model
 * that states no `icon` at all draws no mark; `elevenlabs-sfx-v2` is one
 * today (todo #2060 puts a guard on the names that ARE stated).
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
  // Two upright bars, reading as the "11" the vendor is named for.
  elevenlabs: (
    <>
      <rect x='6.2' y='3.6' width='4' height='16.8' rx='0.6' />
      <rect x='13.8' y='3.6' width='4' height='16.8' rx='0.6' />
    </>
  ),
  // A fish swimming right, its eye cut out of the body.
  'fish-audio': (
    <path
      fillRule='evenodd'
      d='M2.4 12C4.8 8.4 8.8 6.4 12.8 7 15.7 7.4 18.1 9.2 19.5 12 18.1 14.8 15.7 16.6 12.8 17 8.8 17.6 4.8 15.6 2.4 12ZM19.2 8.3 22.4 12 19.2 15.7 20.1 12ZM8.4 10.7A1.15 1.15 0 1 0 8.4 13 1.15 1.15 0 1 0 8.4 10.7Z'
    />
  ),
  // A microphone on its stand.
  qwen: (
    <>
      <rect x='9' y='2.6' width='6' height='10.8' rx='3' />
      <path d='M5.6 11.2A1.1 1.1 0 0 0 3.4 11.2 8.7 8.7 0 0 0 10.9 19.8V21.2A1.1 1.1 0 0 0 13.1 21.2V19.8A8.7 8.7 0 0 0 20.6 11.2 1.1 1.1 0 0 0 18.4 11.2 6.5 6.5 0 0 1 5.6 11.2Z' />
    </>
  ),
  // A sound spreading from a point: a dot with two arcs opening off it.
  sonilo: (
    <>
      <circle cx='4.5' cy='12' r='2.2' />
      <path d='M8.87 6.79A6.8 6.8 0 0 1 8.87 17.21L7.84 15.98A5.2 5.2 0 0 0 7.84 8.02Z' />
      <path d='M11.19 4.03A10.4 10.4 0 0 1 11.19 19.97L10.16 18.74A8.8 8.8 0 0 0 10.16 5.26Z' />
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
