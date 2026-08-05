// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  applyCaretName,
  caretColor,
  renderCollabCaret,
  renderCollabSelection,
  shouldRenderLabelBelow,
  shouldFlipLabelLeft,
} from '@web/features/collab-editor/caret-render';
import { resolvePaletteHex, userPaletteHue } from '@web/lib/user-color';

/** A resolver that knows exactly one collaborator. */
const knows =
  (id: string, name: string) =>
    (userId: string): string | null =>
      userId === id ? name : null;

/** A resolver that knows nobody — the roster has not arrived yet. */
const knowsNobody = (): string | null => null;

// #1882: awareness now carries the user id and NOTHING else about identity.
// Colour is derived from that id on the receiving side, so the two clients
// cannot disagree about it and there is no free-form colour string on the
// wire to sanitise in the first place.
describe('caretColor — derived from the user id, never from the wire', () => {
  it('derives the palette token from the user id', () => {
    const id = 'user-42';
    expect(caretColor({ id })).toBe(`var(--color-palette-${userPaletteHue(id)})`);
  });

  it('agrees with the colour the sender computes for itself from the same id', () => {
    // The sender used to publish a pre-computed colour; both sides now run the
    // same derivation, so a caret cannot be one colour for its owner and
    // another for everyone else.
    const id = 'user-7';
    expect(caretColor({ id })).toBe(`var(--color-palette-${userPaletteHue(id)})`);
    expect(resolvePaletteHex(userPaletteHue(id))).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('ignores colour fields a malicious client smuggles into awareness', () => {
    // A peer can put anything in its awareness state. Nothing reads these
    // fields any more, so a `;background:url(...)` beacon has no door left.
    const hostile = {
      id: 'user-42',
      color: 'red;background:url(https://evil.example)',
      hue: 'red;background:url(https://evil.example)',
    } as { id: string };
    expect(caretColor(hostile)).toBe(
      `var(--color-palette-${userPaletteHue('user-42')})`,
    );
    expect(caretColor(hostile)).not.toContain('evil.example');
  });

  it('falls back to a neutral token when the id is missing or empty', () => {
    expect(caretColor({})).toBe('var(--color-muted-foreground)');
    expect(caretColor({ id: '' })).toBe('var(--color-muted-foreground)');
  });
});

describe('renderCollabCaret — caret DOM for a remote collaborator', () => {
  it('resolves the name from the roster by user id, colours from the same id', () => {
    const el = renderCollabCaret(
      { id: 'user-42' },
      undefined,
      knows('user-42', 'Grace'),
    );
    const expected = `var(--color-palette-${userPaletteHue('user-42')})`;
    expect(el.classList.contains('collaboration-carets__caret')).toBe(true);
    expect(el.style.borderColor).toContain(expected);
    const label = el.querySelector('.collaboration-carets__label');
    expect(label?.textContent).toBe('Grace');
    expect((label as HTMLElement).style.backgroundColor).toContain(expected);
  });

  it('a markup-looking name stays inert text (no element is parsed from it)', () => {
    const el = renderCollabCaret(
      { id: 'user-9' },
      undefined,
      knows('user-9', '<img src=x onerror=alert(1)>'),
    );
    const label = el.querySelector('.collaboration-carets__label');
    expect(label?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(label?.querySelector('img')).toBeNull();
  });

  it('draws the bare colour line, no label, while the name is unresolved', () => {
    // The roster is fetched, not broadcast, so a caret can appear before its
    // owner's name is known. An empty label would flash a coloured box with
    // nothing in it; the caret line alone reads as "someone is here".
    const el = renderCollabCaret({ id: 'user-42' }, undefined, knowsNobody);
    expect(el.classList.contains('collaboration-carets__caret')).toBe(true);
    expect(el.querySelector('.collaboration-carets__label')).toBeNull();
  });

  it('treats an empty resolved name as unresolved, not as a name', () => {
    // The roster merge fills `name: profile?.name ?? ''` for a member whose
    // profile query has not landed, so "known but blank" and "absent" arrive
    // through the same door and must be handled the same way.
    const el = renderCollabCaret({ id: 'user-42' }, undefined, () => '');
    expect(el.querySelector('.collaboration-carets__label')).toBeNull();
  });

  it('stamps the client id so the roster-update listener can find this caret', () => {
    const el = renderCollabCaret({ id: 'user-42' }, 77, knows('user-42', 'G'));
    expect(el.dataset.clientId).toBe('77');
  });
});

// The selection highlight has to derive its colour the same way the caret
// does. It used to have its own door: the extension's default builder inlined
// the raw remote `user.color` into a style attribute, which is why an override
// exists at all (adversarial round-1 HIGH). With the colour derived from the
// id there is no remote string in either path.
describe('renderCollabSelection — remote selection highlight attrs', () => {
  it('builds the highlight from the id-derived colour, translucent via color-mix', () => {
    const attrs = renderCollabSelection({ id: 'user-42' });
    expect(attrs.class).toBe('collaboration-carets__selection');
    expect(attrs.style).toContain(
      `var(--color-palette-${userPaletteHue('user-42')})`,
    );
    expect(attrs.style).toContain('color-mix');
  });

  // The per-user color is exposed ONLY as a custom property, with NO direct
  // background-color: index.css decides the shape per element (rectangle on text,
  // rounded pill on a chip — never the chip's rectangular wrapper), so a remote
  // selection over a chip follows the pill's rounded shape (B, user 2026-07-13).
  it('exposes only the --collab-selection-bg custom property, no direct background', () => {
    const attrs = renderCollabSelection({ id: 'user-42' });
    expect(attrs.style).toContain('--collab-selection-bg:');
    expect(attrs.style).not.toContain('background-color');
  });

  it('ignores colour fields smuggled into awareness', () => {
    const attrs = renderCollabSelection({
      id: 'user-42',
      color: '#000;background-image:url(https://evil.example/beacon)',
      hue: 'red;background:url(https://evil.example)',
    } as { id: string });
    expect(attrs.style).not.toContain('evil.example');
  });

  it('falls back to the neutral token when the id is missing', () => {
    expect(renderCollabSelection({}).style).toContain(
      'var(--color-muted-foreground)',
    );
  });

  it('dims a BLURRED collaborator via a lower mix ratio (never CSS opacity on the text)', () => {
    expect(renderCollabSelection({ id: 'u', focused: false }).style).toContain('12%');
    expect(renderCollabSelection({ id: 'u', focused: true }).style).toContain('25%');
    expect(renderCollabSelection({ id: 'u' }).style).toContain('25%'); // old clients
  });
});

describe('renderCollabCaret — blurred (window unfocused) collaborator dims', () => {
  it('adds the --blurred modifier ONLY on the literal focused === false', () => {
    const named = knows('u', 'A');
    const blurred = renderCollabCaret({ id: 'u', focused: false }, undefined, named);
    expect(blurred.classList.contains('collaboration-carets__caret--blurred')).toBe(true);
    const focused = renderCollabCaret({ id: 'u', focused: true }, undefined, named);
    expect(focused.classList.contains('collaboration-carets__caret--blurred')).toBe(false);
    const legacy = renderCollabCaret({ id: 'u' }, undefined, named); // field absent
    expect(legacy.classList.contains('collaboration-carets__caret--blurred')).toBe(false);
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

describe('collaboration caret CSS contract (index.css)', () => {
  const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8');

  // A remote caret at the document start renders as a DIRECT child of the block
  // editor (before the <p>); an inline box before a block takes its own line,
  // adding a blank first line for collaborators. It must be taken out of flow
  // (user 2026-07-13, real-DOM + repro confirmed).
  it('takes a document-start caret (direct editor child) out of flow (no blank first line)', () => {
    expect(css).toMatch(
      /\.ProseMirror\s*>\s*\.collaboration-carets__caret\s*\{[^}]*position:\s*absolute[^}]*\}/,
    );
  });
});

describe('the label flip is actually wired to a scroll viewport', () => {
  // The two decision functions above are pure and well covered. What is not
  // covered by them is the LOOKUP that feeds them: the caret finds its clipping
  // container with `closest('[data-radix-scroll-area-viewport]')`, and a missed
  // lookup returns early in silence. Re-scope that selector to a test id, a
  // class, or `.ProseMirror` and every editor loses both flips with nothing to
  // show for it — which is exactly what the previous selector was doing.

  /** Place a caret inside a container and give both a fixed geometry. */
  function mount(opts: {
    inViewport: boolean;
    caretTop: number;
    caretLeft: number;
  }): { caret: HTMLElement; label: HTMLElement } {
    const container = document.createElement('div');
    if (opts.inViewport) container.setAttribute('data-radix-scroll-area-viewport', '');
    document.body.appendChild(container);

    const caret = renderCollabCaret(
      { id: 'them' },
      undefined,
      knows('them', 'Them'),
    );
    container.appendChild(caret);
    const label = caret.querySelector('.collaboration-carets__label') as HTMLElement;

    container.getBoundingClientRect = (): DOMRect =>
      ({ top: 100, left: 0, right: 500, bottom: 900 }) as DOMRect;
    Object.defineProperty(container, 'clientWidth', { value: 500, configurable: true });
    Object.defineProperty(container, 'clientLeft', { value: 0, configurable: true });
    caret.getBoundingClientRect = (): DOMRect =>
      ({ top: opts.caretTop, left: opts.caretLeft }) as DOMRect;
    label.getBoundingClientRect = (): DOMRect => ({ width: 80 }) as DOMRect;
    return { caret, label };
  }

  /** Run whatever the caret scheduled for the next frame. */
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('flips the label below for a caret on the first line', async () => {
    // Caret 5px under the viewport top: inside the 20px threshold.
    const { label } = mount({ inViewport: true, caretTop: 105, caretLeft: 10 });
    await nextFrame();
    expect(label.classList.contains('collaboration-carets__label--below')).toBe(true);
  });

  it('leaves the label above once the caret clears the first line', async () => {
    const { label } = mount({ inViewport: true, caretTop: 400, caretLeft: 10 });
    await nextFrame();
    expect(label.classList.contains('collaboration-carets__label--below')).toBe(false);
  });

  it('flips the label left near the viewport right edge', async () => {
    // An 80px label anchored at x=460 would end at 540, past the 500px content
    // right — and past it by more than the 8px threshold.
    const { label } = mount({ inViewport: true, caretTop: 400, caretLeft: 460 });
    await nextFrame();
    expect(label.classList.contains('collaboration-carets__label--flip-left')).toBe(true);
  });

  it('re-measures when a late name replaces the text of a parked label', async () => {
    // The repair path writes into a caret that is NOT rebuilt — the renderer
    // reuses parked caret DOM by client id — so nothing else will retake the
    // flip decision. A name that arrives longer than the placeholder it
    // replaces has to flip a label that was correctly left alone before.
    const { caret, label } = mount({
      inViewport: true,
      caretTop: 400,
      caretLeft: 440,
    });
    let labelWidth = 40;
    label.getBoundingClientRect = (): DOMRect =>
      ({ width: labelWidth }) as DOMRect;

    await nextFrame();
    // 440 + 40 = 480, clear of the 492 threshold.
    expect(label.classList.contains('collaboration-carets__label--flip-left')).toBe(false);

    labelWidth = 80;
    applyCaretName(caret, 'A Much Longer Name', 'var(--color-palette-1)');
    await nextFrame();
    // 440 + 80 = 520, past it.
    expect(label.classList.contains('collaboration-carets__label--flip-left')).toBe(true);
    expect(label.textContent).toBe('A Much Longer Name');
  });

  it('does nothing, and does not throw, outside a scroll viewport', async () => {
    // A caret in an editor that does not scroll inside a ScrollArea. The flip
    // is meaningless there, and the lookup missing must not be an error.
    const { label } = mount({ inViewport: false, caretTop: 105, caretLeft: 460 });
    await nextFrame();
    expect(label.classList.contains('collaboration-carets__label--below')).toBe(false);
    expect(label.classList.contains('collaboration-carets__label--flip-left')).toBe(false);
  });
});
