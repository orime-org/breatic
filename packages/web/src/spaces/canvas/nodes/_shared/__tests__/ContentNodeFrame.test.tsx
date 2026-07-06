// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';

describe('ContentNodeFrame', () => {
  // #1449: the frame renders the name header (not the modality body), so it must
  // thread `selected` down to NodeHeader for the active-name colour to work.
  // Selected → the name uses the strong foreground; unselected → muted.
  it('selected: threads selection to the header (strong foreground name)', () => {
    render(
      <ContentNodeFrame modality='image' name='Hero' selected>
        <div />
      </ContentNodeFrame>,
    );
    expect(screen.getByTestId('node-header')).toHaveClass('text-foreground');
  });

  it('unselected: the name dims to the muted foreground', () => {
    render(
      <ContentNodeFrame modality='image' name='Hero'>
        <div />
      </ContentNodeFrame>,
    );
    expect(screen.getByTestId('node-header')).toHaveClass(
      'text-muted-foreground',
    );
  });

  // #1616: image/video nodes show their pixel resolution in a badge mirroring
  // the name header. The badge is its OWN corner anchor pinned to the card's
  // top-RIGHT (origin-bottom-right), so it stays glued to the right corner at
  // every zoom — a full-width justify-between row drifted the badge off-corner
  // (mid-card above 100%, past the right edge below 100%).
  it('resolution present + idle: badge is a top-right corner anchor', () => {
    render(
      <ContentNodeFrame
        modality='image'
        name='Hero'
        status='idle'
        resolution={{ width: 1920, height: 1080 }}
      >
        <div />
      </ContentNodeFrame>,
    );
    const badge = screen.getByTestId('node-resolution-badge');
    expect(badge).toHaveTextContent('1920×1080');
    const anchor = screen.getByTestId('node-resolution-anchor');
    expect(anchor).toContainElement(badge);
    expect(anchor).toHaveClass('bottom-full');
    expect(anchor).toHaveClass('right-0');
    expect(anchor).toHaveClass('origin-bottom-right');
  });

  it('no resolution: no badge is rendered (empty / unloaded state)', () => {
    render(
      <ContentNodeFrame modality='image' name='Hero' status='idle'>
        <div />
      </ContentNodeFrame>,
    );
    expect(screen.queryByTestId('node-resolution-badge')).toBeNull();
  });

  it('resolution follows selection (strong foreground when selected)', () => {
    render(
      <ContentNodeFrame
        modality='image'
        name='Hero'
        selected
        status='idle'
        resolution={{ width: 1920, height: 1080 }}
      >
        <div />
      </ContentNodeFrame>,
    );
    expect(screen.getByTestId('node-resolution-badge')).toHaveClass(
      'text-foreground',
    );
  });

  // #1616 adversarial fix: the badge describes the CURRENTLY DISPLAYED media, so
  // it must hide whenever the media element is unmounted — during in-place
  // regeneration (handling → skeleton) or error — even if a resolution was
  // already read. Otherwise a stale size floats over the skeleton / error UI.
  it('handling: hides the badge even when a resolution is known', () => {
    render(
      <ContentNodeFrame
        modality='image'
        name='Hero'
        status='handling'
        resolution={{ width: 1920, height: 1080 }}
      >
        <div />
      </ContentNodeFrame>,
    );
    expect(screen.queryByTestId('node-resolution-badge')).toBeNull();
  });

  it('error: hides the badge even when a resolution is known', () => {
    render(
      <ContentNodeFrame
        modality='image'
        name='Hero'
        status='error'
        resolution={{ width: 1920, height: 1080 }}
      >
        <div />
      </ContentNodeFrame>,
    );
    expect(screen.queryByTestId('node-resolution-badge')).toBeNull();
  });
});
