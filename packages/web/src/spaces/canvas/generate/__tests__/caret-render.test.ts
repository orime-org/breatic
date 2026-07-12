// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  renderCollabCaret,
  renderCollabSelection,
  safeCaretColor,
  shouldRenderLabelBelow,
  shouldFlipLabelLeft,
} from '@web/spaces/canvas/generate/caret-render';

// Awareness payloads are UNTRUSTED wire data from other clients (CRITICAL
// PATH — Yjs collab). The renderer must never inline a free-form remote
// string into a style attribute: `;background:url(...)` smuggled through
// user.color would fire a request beacon on every caret render.
describe('safeCaretColor — untrusted awareness identity → safe CSS color', () => {
  it('renders a whitelisted hue as the theme-adaptive palette token var', () => {
    expect(safeCaretColor({ hue: 'pink', color: '#c2298a' })).toBe(
      'var(--color-palette-pink)',
    );
  });

  it('falls back to the wire color only when it is a strict 6-digit hex', () => {
    expect(safeCaretColor({ hue: 'not-a-hue', color: '#12ab3F' })).toBe(
      '#12ab3F',
    );
    expect(safeCaretColor({ color: '#abcdef' })).toBe('#abcdef');
  });

  it('rejects style-injection payloads in both fields (neutral token instead)', () => {
    expect(
      safeCaretColor({
        hue: 'red;background:url(https://evil.example)',
        color: 'red;background:url(https://evil.example)',
      }),
    ).toBe('var(--color-muted-foreground)');
    expect(safeCaretColor({ color: '#fff' })).toBe(
      'var(--color-muted-foreground)',
    );
    expect(safeCaretColor({})).toBe('var(--color-muted-foreground)');
  });
});

describe('renderCollabCaret — caret DOM for a remote collaborator', () => {
  it('builds caret + label colored via the safe color, name as a text node', () => {
    const el = renderCollabCaret({
      name: 'Grace',
      color: '#c2298a',
      hue: 'pink',
    });
    expect(el.classList.contains('collaboration-carets__caret')).toBe(true);
    expect(el.style.borderColor).toContain('var(--color-palette-pink)');
    const label = el.querySelector('.collaboration-carets__label');
    expect(label?.textContent).toBe('Grace');
    expect((label as HTMLElement).style.backgroundColor).toContain(
      'var(--color-palette-pink)',
    );
  });

  it('a markup-looking name stays inert text (no element is parsed from it)', () => {
    const el = renderCollabCaret({
      name: '<img src=x onerror=alert(1)>',
      hue: 'teal',
    });
    const label = el.querySelector('.collaboration-carets__label');
    expect(label?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(label?.querySelector('img')).toBeNull();
  });
});

// Adversarial round-1 HIGH: hardening only the cursor widget left the
// SELECTION highlight on the extension's default builder, which inlines the
// raw remote user.color into a style attribute — the exact
// `;background:url(...)` beacon vector caret-render defends against, through
// the second door. The selection builder must route through safeCaretColor.
describe('renderCollabSelection — remote selection highlight attrs', () => {
  it('builds the highlight from the whitelisted hue, translucent via color-mix', () => {
    const attrs = renderCollabSelection({ hue: 'pink', color: '#c2298a' });
    expect(attrs.class).toBe('collaboration-carets__selection');
    expect(attrs.style).toContain('var(--color-palette-pink)');
    expect(attrs.style).toContain('color-mix');
  });

  it('never inlines a style-injection payload (neutral token instead)', () => {
    const attrs = renderCollabSelection({
      hue: 'red;background:url(https://evil.example)',
      color: '#000;background-image:url(https://evil.example/beacon)',
    });
    expect(attrs.style).not.toContain('evil.example');
    expect(attrs.style).toContain('var(--color-muted-foreground)');
  });
});

// First-line label flip (D, user 2026-07-12): a caret whose top sits within the
// clip threshold of the scroll-viewport top would have its above-label clipped,
// so the label flips below instead. Pure geometry decision (the caller measures).
describe('shouldRenderLabelBelow — first-line clip → flip below', () => {
  it('flips below when the caret is within the threshold of the viewport top', () => {
    // caret 8px below the viewport top (first line, py-2) < 20px threshold.
    expect(shouldRenderLabelBelow(108, 100, 20)).toBe(true);
  });

  it('stays above once the caret clears the threshold (later lines)', () => {
    // caret 26px below the viewport top (second line) > 20px threshold.
    expect(shouldRenderLabelBelow(126, 100, 20)).toBe(false);
  });

  it('flips below at the exact viewport top (a caret scrolled flush to the edge)', () => {
    expect(shouldRenderLabelBelow(100, 100, 20)).toBe(true);
  });
});

describe('shouldFlipLabelLeft — right-edge clip → flip left (B4)', () => {
  it('flips left when a left-anchored label would overrun the viewport right', () => {
    // caret at 380, 60px label → right edge 440 > container right 400 - 8.
    expect(shouldFlipLabelLeft(380, 60, 400, 8)).toBe(true);
  });

  it('stays right-extending when the label fits before the right edge', () => {
    // caret at 200, 60px label → right edge 260, well within 400 - 8.
    expect(shouldFlipLabelLeft(200, 60, 400, 8)).toBe(false);
  });

  it('flips within the threshold margin (padding + scrollbar) before the exact edge', () => {
    // right edge 395 is inside the 8px margin of container right 400.
    expect(shouldFlipLabelLeft(335, 60, 400, 8)).toBe(true);
  });
});
