// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/**
 * Self-drawn, monochrome (black/white/grey via `currentColor`) marks for the
 * model picker, one per model vendor. Each EVOKES the vendor's real logo
 * rather than reproducing the trademarked artwork; where reproducing it would
 * be reproducing the trademark itself, or no vendor mark is recognisable (an
 * open model served by the gateway), the mark names what the model does
 * instead (`qwen`, `sonilo`, `omnivoice`, `vocal-isolator`, `infinitetalk`,
 * `rife`). ByteDance's Seed models all carry `seedream`.
 *
 * Every model a picker offers names one of these, and every one of these is
 * named by such a model: there is deliberately NO generic "unknown model"
 * fallback (user 2026-07-09), and `ModelIcon.test.tsx` walks the yaml both
 * ways.
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
  // A wave: three rising bars, the shape a music model's output takes.
  minimax: (
    <>
      <rect x='3.6' y='10' width='3.2' height='10' rx='1.2' />
      <rect x='10.4' y='4' width='3.2' height='16' rx='1.2' />
      <rect x='17.2' y='7.5' width='3.2' height='12.5' rx='1.2' />
    </>
  ),
  // Two upright bars, reading as the "11" the vendor is named for.
  elevenlabs: (
    <>
      <rect x='6.2' y='3.6' width='4' height='16.8' rx='0.6' />
      <rect x='13.8' y='3.6' width='4' height='16.8' rx='0.6' />
    </>
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
  // Three interlaced loops, evoking OpenAI's knot.
  openai: (
    <g fill='none' stroke='currentColor' strokeWidth='1.9'><ellipse cx='12' cy='12' rx='3.6' ry='8.4' /><ellipse cx='12' cy='12' rx='3.6' ry='8.4' transform='rotate(60 12 12)' /><ellipse cx='12' cy='12' rx='3.6' ry='8.4' transform='rotate(120 12 12)' /></g>
  ),
  // A broken X, evoking xAI's slash mark.
  xai: (
    <><path d='M3.5 4h4.2l12.8 16h-4.2Z' /><path d='M20.5 4h-3.4l-4.6 5.8 1.7 2.1Z' /><path d='M3.5 20h3.4l3.9-4.9-1.7-2.1Z' /></>
  ),
  // An infinity loop, evoking Meta's mark.
  meta: (
    <g fill='none' stroke='currentColor' strokeWidth='2.4' strokeLinejoin='round'><path d='M3.6 12c0-4.3 2.4-6.2 4.4-6.2 3.2 0 5.2 4.6 8 9.4 1 1.7 1.9 3 3.1 3 1.2 0 1.3-1.9 1.3-6.2 0-4.3-2.4-6.2-4.4-6.2-3.2 0-5.2 4.6-8 9.4-1 1.7-1.9 3-3.1 3-1.2 0-1.3-1.9-1.3-6.2Z' /></g>
  ),
  // A pen nib: the vector work Recraft is known for.
  recraft: (
    <><path fillRule='evenodd' d='M12 2.5 18 11 15.6 17.4H8.4L6 11ZM11.2 10.4V14.4H12.8V10.4A1.5 1.5 0 1 0 11.2 10.4Z' /><rect x='8' y='18.6' width='8' height='2.9' rx='1' /></>
  ),
  // An R drawn in one stroke, for Reve.
  reve: (
    <g fill='none' stroke='currentColor' strokeWidth='2.6' strokeLinecap='round' strokeLinejoin='round'><path d='M7 20.5V3.5h5.5a4.6 4.6 0 0 1 0 9.2H7' /><path d='M12.4 12.7 18 20.5' /></g>
  ),
  // Three flowing lines, for Sourceful's Riverflow.
  sourceful: (
    <g fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round'><path d='M3 7c3-2.6 6-2.6 9 0s6 2.6 9 0' /><path d='M3 12c3-2.6 6-2.6 9 0s6 2.6 9 0' /><path d='M3 17c3-2.6 6-2.6 9 0s6 2.6 9 0' /></g>
  ),
  // A faceted crystal, for Clarity AI's Crystal upscaler.
  clarity: (
    <><path fillRule='evenodd' d='M6.2 3.5h11.6L22 9.2 12 21 2 9.2ZM7.2 5.3 5 8.4h4.1ZM12 5.3 10.2 8.4h3.6ZM16.8 5.3 14.9 8.4H19ZM5.4 10.2 10.6 16.4 8.9 10.2ZM10.8 10.2 12 17.3 13.2 10.2ZM15.1 10.2 13.4 16.4 18.6 10.2Z' /></>
  ),
  // A figure inside a dashed frame: a subject cut from its background.
  bria: (
    <><circle cx='12' cy='9' r='3.2' /><path d='M5.8 19.2c.6-3.6 3.1-5.6 6.2-5.6s5.6 2 6.2 5.6Z' /><path fill='none' stroke='currentColor' strokeWidth='1.6' strokeDasharray='2.2 2' d='M2.8 2.8h18.4v18.4H2.8Z' /></>
  ),
  // A four-point sparkle, evoking Google Gemini.
  gemini: (
    <><path d='M12 2c.8 5.6 4.4 9.2 10 10-5.6.8-9.2 4.4-10 10-.8-5.6-4.4-9.2-10-10 5.6-.8 9.2-4.4 10-10Z' /></>
  ),
  // Two beamed notes, for Mureka's songs.
  mureka: (
    <><path d='M9 4.6 20 2.6v12.9a3 3 0 1 1-2-2.8V7.4l-7 1.3v9.1a3 3 0 1 1-2-2.8Z' /></>
  ),
  // A point bursting outward, for Mirelo's sound effects.
  mirelo: (
    <><circle cx='12' cy='12' r='3' /><g stroke='currentColor' strokeWidth='2.2' strokeLinecap='round'><path d='M12 2.6v3M12 18.4v3M2.6 12h3M18.4 12h3M5.4 5.4l2.1 2.1M16.5 16.5l2.1 2.1M18.6 5.4l-2.1 2.1M7.5 16.5l-2.1 2.1' /></g></>
  ),
  // A two-part circle with a dot in each half, evoking Tencent Hunyuan.
  hunyuan: (
    <><path fillRule='evenodd' d='M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19Zm0 1.9a7.6 7.6 0 0 0 0 15.2 3.8 3.8 0 0 1 0-7.6 3.8 3.8 0 0 0 0-7.6Zm0 10.1a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z' /><circle cx='12' cy='8.2' r='1.3' /></>
  ),
  // A speech bubble, for Inworld's voices.
  inworld: (
    <><path d='M4 4.2h16a1.8 1.8 0 0 1 1.8 1.8v9.6a1.8 1.8 0 0 1-1.8 1.8h-8.6L6.4 21v-3.6H4a1.8 1.8 0 0 1-1.8-1.8V6A1.8 1.8 0 0 1 4 4.2Z' /></>
  ),
  // A voiceprint inside a circle: what the model does, a cloned voice.
  omnivoice: (
    <><path fillRule='evenodd' d='M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19Zm0 1.9a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2Z' /><rect x='7' y='10' width='1.8' height='4' rx='.9' /><rect x='9.9' y='7.6' width='1.8' height='8.8' rx='.9' /><rect x='12.8' y='8.8' width='1.8' height='6.4' rx='.9' /><rect x='15.6' y='10.6' width='1.8' height='2.8' rx='.9' /></>
  ),
  // A waveform with its middle bar drawn out: what the model does, pulling the voice.
  'vocal-isolator': (
    <><rect x='2.6' y='9.5' width='2' height='5' rx='1' /><rect x='5.8' y='6.5' width='2' height='11' rx='1' /><rect x='9' y='8.5' width='2' height='7' rx='1' /><rect x='13' y='4' width='2' height='16' rx='1' opacity='.35' /><rect x='16.2' y='7.5' width='2' height='9' rx='1' /><rect x='19.4' y='10' width='2' height='4' rx='1' /></>
  ),
  // A zigzag W, for Alibaba Wan.
  alibaba: (
    <g fill='none' stroke='currentColor' strokeWidth='2.6' strokeLinecap='round' strokeLinejoin='round'><path d='M3 6l4 12 5-9 5 9 4-12' /></g>
  ),
  // A rounded triangle, evoking Kling's mark.
  kling: (
    <><path d='M6.3 3.2c-1.4-.8-3.1.2-3.1 1.8v14c0 1.6 1.7 2.6 3.1 1.8l12.1-7c1.4-.8 1.4-2.8 0-3.6Z' /></>
  ),
  // An open triangle, evoking Black Forest Labs.
  flux: (
    <><path fillRule='evenodd' d='M12 3 22 20.5H2Zm0 5.4-5.3 9.2h10.6Z' /></>
  ),
  // A pair of lips, for Sync's lipsync.
  sync: (
    <><path d='M2.5 11.6c2.6-3.4 5.7-5.1 7.5-5.1 1 0 1.5.5 2 .5s1-.5 2-.5c1.8 0 4.9 1.7 7.5 5.1-2.4-.6-6.1-.7-9.5-.7s-7.1.1-9.5.7Z' /><path d='M2.5 12.6c2.4.5 6.1.8 9.5.8s7.1-.3 9.5-.8c-2.2 3.4-5.5 5.4-9.5 5.4s-7.3-2-9.5-5.4Z' /></>
  ),
  // An aperture, for Lightricks LTX.
  ltx: (
    <><path fillRule='evenodd' d='M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19Zm0 1.9a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2Z' /><path d='M12 5 16.2 9.5 14.6 15.4 9.4 15.4 7.8 9.5Z' /></>
  ),
  // A face with an open mouth: what the model does, a talking head.
  infinitetalk: (
    <><path fillRule='evenodd' d='M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19Zm0 1.9a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2Z' /><circle cx='9' cy='10' r='1.3' /><circle cx='15' cy='10' r='1.3' /><ellipse cx='12' cy='15.4' rx='2.6' ry='1.7' /></>
  ),
  // A faint frame between two frames: what the model does, interpolation.
  rife: (
    <><rect x='2.5' y='6' width='7' height='12' rx='1.4' /><rect x='14.5' y='6' width='7' height='12' rx='1.4' /><rect x='10.6' y='8' width='2.8' height='8' rx='1' opacity='.45' /></>
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
