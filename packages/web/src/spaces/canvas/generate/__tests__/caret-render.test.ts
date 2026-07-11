// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  renderCollabCaret,
  safeCaretColor,
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
