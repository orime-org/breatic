// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { ReactRenderer } from '@tiptap/react';
import { SuggestionPluginKey } from '@tiptap/suggestion';
import * as Y from 'yjs';

import {
  ReferenceMention,
  referenceMentionContent,
  serializePromptText,
  stripForeignReferenceChips,
} from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import {
  MACHINE_EDIT_META,
  dispatchMachineEdit,
  wasLastChangeLocalUserInput,
} from '@web/spaces/canvas/generate/reference-mention-local-input';
import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

/**
 * Mounts a bare editor carrying the ReferenceMention extension configured with
 * the `@` suggestion.
 * @returns The editor.
 */
function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      ReferenceMention.configure({
        suggestion: makeReferenceSuggestion({
          getPool: () => [],
          emptyLabel: 'No references',
        }),
      }),
    ],
  });
}

describe('ReferenceMention — @ suggestion wiring', () => {
  it('installs the @tiptap/suggestion ProseMirror plugin (so typing @ fires the picker)', () => {
    const editor = makeEditor();
    try {
      // The custom node stores the suggestion option; it must also INSTALL the
      // Suggestion plugin (addProseMirrorPlugins). Without it, typing `@` does
      // nothing — the popup never opens. A live plugin state proves it is wired.
      expect(SuggestionPluginKey.getState(editor.state)).toBeDefined();
    } finally {
      editor.destroy();
    }
  });

  it('registers the referenceMention node in the editor schema', () => {
    const editor = makeEditor();
    try {
      expect(editor.schema.nodes.referenceMention).toBeDefined();
    } finally {
      editor.destroy();
    }
  });

  it('triggers @ after ANY character, not only after a space (allowedPrefixes null)', () => {
    // @tiptap/suggestion defaults allowedPrefixes to [" "], so `@` only fires
    // when preceded by a space or at block start — typing `text@` (e.g. CJK
    // "额@") would NOT open the picker. Setting null lets `@` trigger anywhere.
    const suggestion = makeReferenceSuggestion({
      getPool: () => [],
      emptyLabel: 'No references',
      imageRefsDisabled: () => false,
    });
    expect(suggestion.allowedPrefixes).toBeNull();
  });

  // Connection rules (spec §9.1): new audio/video wires into an image node are
  // rejected at the wire level, but LEGACY edges created before the rules may
  // still exist in old documents. The @ picker must not offer a reference that
  // can never satisfy image generation (the adversarial dead-end: pick an
  // audio ref → execute reports "no source image"). The rail still shows the
  // legacy row so the user can see and remove it.
  it('filters type-incompatible legacy references out of the @ picker (image target keeps image/text)', () => {
    const pool = [
      {
        refId: 'e1',
        sourceNodeId: 'a',
        sourceNodeType: 'image',
        sourceNodeName: 'Pic',
      },
      {
        refId: 'e2',
        sourceNodeId: 'b',
        sourceNodeType: 'text',
        sourceNodeName: 'Note',
      },
      {
        refId: 'e3',
        sourceNodeId: 'c',
        sourceNodeType: 'audio',
        sourceNodeName: 'Song',
      },
      {
        refId: 'e4',
        sourceNodeId: 'd',
        sourceNodeType: 'video',
        sourceNodeName: 'Clip',
      },
    ];
    const suggestion = makeReferenceSuggestion({
      getPool: () =>
        pool as unknown as ReturnType<
          Parameters<typeof makeReferenceSuggestion>[0]['getPool']
        >,
      emptyLabel: 'No references',
    });
    const items = (
      suggestion.items as unknown as (input: {
        query: string;
      }) => { refId: string }[]
    )({ query: '' });
    expect(items.map((i) => i.refId)).toEqual(['e1', 'e2']);
  });

  // t2i ignores source images, so the `@` picker must not offer image refs
  // (user 2026-07-18) — with only images in the pool the picker never opens.
  // Text refs still feed the prompt in t2i, so they stay.
  it('excludes image references from the @ picker when imageRefsDisabled (t2i), keeping text', () => {
    const pool = [
      { refId: 'e1', sourceNodeId: 'a', sourceNodeType: 'image', sourceNodeName: 'Pic' },
      { refId: 'e2', sourceNodeId: 'b', sourceNodeType: 'text', sourceNodeName: 'Note' },
    ];
    const suggestion = makeReferenceSuggestion({
      getPool: () =>
        pool as unknown as ReturnType<
          Parameters<typeof makeReferenceSuggestion>[0]['getPool']
        >,
      emptyLabel: 'No references',
      imageRefsDisabled: () => true,
    });
    const items = (
      suggestion.items as unknown as (input: {
        query: string;
      }) => { refId: string }[]
    )({ query: '' });
    expect(items.map((i) => i.refId)).toEqual(['e2']);
  });
});

// I3 (batch-5, user 2026-07-12): typing `@` as ordinary text (no matching
// reference in the pool) still popped a "No connected references" box, which
// was noise. The popup must appear ONLY when the pool has ≥1 matching row —
// zero matches shows nothing at all, so plain `@` typing is uninterrupted.
describe('makeReferenceSuggestion — popup hidden when no items match', () => {
  const row: ReferenceRailItem = {
    refId: 'a->me',
    sourceNodeId: 'a',
    sourceNodeType: 'image',
    sourceNodeName: 'Pic',
    thumbnail: 'a.png',
  };

  type RenderHandlers = ReturnType<
    NonNullable<ReturnType<typeof makeReferenceSuggestion>['render']>
  >;
  type StartProps = Parameters<NonNullable<RenderHandlers['onStart']>>[0];

  /**
   * Builds a minimal SuggestionProps for driving the render() handlers.
   * @param items - The current suggestion items.
   * @param editor - The host editor.
   * @returns A props object cast to the suggestion props shape.
   */
  function props(items: ReferenceRailItem[], editor: Editor): StartProps {
    return {
      editor,
      items,
      command: vi.fn(),
      clientRect: () => new DOMRect(0, 0, 10, 10),
      query: '',
      text: '',
      range: { from: 0, to: 0 },
      decorationNode: null,
    } as unknown as StartProps;
  }

  it('on outside-click HIDES the popup but keeps the suggestion alive so re-typing re-shows it (B2)', () => {
    const suggestion = makeReferenceSuggestion({
      getPool: () => [row],
      emptyLabel: 'No references',
      imageRefsDisabled: () => false,
      // Driving onStart/onUpdate by hand has no real transaction to advance the
      // tracker plugin, so inject the local-keystroke signal these tests model
      // (the popup opens because the user typed `@`).
      isLocalUserInput: () => true,
    });
    const render = suggestion.render;
    if (!render) throw new Error('render missing');
    const handlers = render();
    const editor = makeEditor();
    const before = new Set(Array.from(document.body.children));
    try {
      handlers.onStart?.(props([row], editor));
      const el = Array.from(document.body.children).find(
        (c) => !before.has(c),
      ) as HTMLElement;
      expect(el.style.display).toBe(''); // shown while typing @I
      // Blur / click a panel control: a capture-phase pointerdown outside the
      // popup AND the editor. It must HIDE the popup, NOT remove it (that would
      // mean exitSuggestion killed the range → the picker never comes back until
      // the editor remounts — the B2 bug).
      document.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
      expect(el.style.display).toBe('none'); // hidden
      expect(document.body.contains(el)).toBe(true); // NOT removed → still alive
      // Re-focusing the editor (clicking back in) re-shows the popup WITHOUT any
      // keystroke (B2 residual, user 2026-07-12): the fresh-panel behavior is that
      // clicking to activate immediately shows the picker.
      editor.view.dom.dispatchEvent(new FocusEvent('focus'));
      expect(el.style.display).toBe('');
      // And after another hide, continuing to type (onUpdate) also re-shows.
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      expect(el.style.display).toBe('none');
      handlers.onUpdate?.(props([row], editor));
      expect(el.style.display).toBe('');
    } finally {
      handlers.onExit?.(props([], editor));
      editor.destroy();
    }
  });

  it('hides the popup on start with zero items and shows it once items arrive', () => {
    const suggestion = makeReferenceSuggestion({
      getPool: () => [],
      emptyLabel: 'No references',
      imageRefsDisabled: () => false,
      isLocalUserInput: () => true, // manual driving models a local `@` keystroke
    });
    const render = suggestion.render;
    if (!render) throw new Error('render missing');
    const handlers = render();
    const editor = makeEditor();
    const before = new Set(Array.from(document.body.children));
    try {
      handlers.onStart?.(props([], editor));
      const el = Array.from(document.body.children).find(
        (c) => !before.has(c),
      ) as HTMLElement;
      expect(el).toBeDefined();
      expect(el.style.display).toBe('none'); // zero matches → hidden
      handlers.onUpdate?.(props([row], editor));
      expect(el.style.display).toBe(''); // a match arrived → shown
      handlers.onUpdate?.(props([], editor));
      expect(el.style.display).toBe('none'); // narrowed back to zero → hidden
    } finally {
      handlers.onExit?.(props([], editor));
      editor.destroy();
    }
  });
});

// #1799 / #1800: an ACTIVE `@` popup can be HIDDEN (clicking a panel control —
// e.g. the mode toggle — hides it via the outside-click handler, B2) and then
// RE-SHOWN on refocus. The re-show must recompute its list from the LIVE pool +
// LIVE mode, because @tiptap/suggestion only re-runs items() on a query / range
// change — and a mode toggle lives on the canvas node, not the prompt doc, so it
// is neither. Without the recompute the re-shown popup kept the pre-toggle list:
// t2i's text-only rows after switching to i2i (#1799), and never the focus crops
// i2i should offer (#1800).
describe('makeReferenceSuggestion — refocus re-show recomputes for the live mode (#1799/#1800)', () => {
  const textRow: ReferenceRailItem = {
    refId: 't->me',
    sourceNodeId: 't',
    sourceNodeType: 'text',
    sourceNodeName: 'Note',
    textContent: 'hi',
  };
  const imageRow: ReferenceRailItem = {
    refId: 'i->me',
    sourceNodeId: 'i',
    sourceNodeType: 'image',
    sourceNodeName: 'Pic',
    thumbnail: 'i.png',
  };
  const focusRow: ReferenceRailItem = {
    refId: 'focus:c1',
    sourceNodeId: 'focus:c1',
    sourceNodeType: 'image',
    sourceNodeName: 'Crop',
    thumbnail: 'c.png',
    focus: true,
  };

  type RenderHandlers = ReturnType<
    NonNullable<ReturnType<typeof makeReferenceSuggestion>['render']>
  >;
  type StartProps = Parameters<NonNullable<RenderHandlers['onStart']>>[0];

  /**
   * Builds a minimal SuggestionProps for driving the render() handlers.
   * @param items - The current suggestion items.
   * @param editor - The host editor.
   * @returns A props object cast to the suggestion props shape.
   */
  function props(items: ReferenceRailItem[], editor: Editor): StartProps {
    return {
      editor,
      items,
      command: vi.fn(),
      clientRect: () => new DOMRect(0, 0, 10, 10),
      query: '',
      text: '',
      range: { from: 0, to: 0 },
      decorationNode: null,
    } as unknown as StartProps;
  }

  it('offers focus crops + image rows in i2i but only text in t2i (items filter)', () => {
    const pool = [textRow, imageRow, focusRow];
    const ids = (hideImages: boolean): string[] => {
      const s = makeReferenceSuggestion({
        getPool: () => pool,
        emptyLabel: 'No references',
        imageRefsDisabled: () => hideImages,
      });
      return (
        (s.items?.({ query: '', editor: undefined as unknown as Editor }) ??
          []) as ReferenceRailItem[]
      )
        .map((r) => r.sourceNodeId)
        .sort();
    };
    // t2i drops every image (incl. focus crops, which are images); i2i offers all.
    expect(ids(true)).toEqual(['t']);
    expect(ids(false)).toEqual(['focus:c1', 'i', 't']);
  });

  it('recomputes the re-shown list for the live mode on refocus (image + focus appear after t2i→i2i)', () => {
    let hideImages = true; // start in t2i
    const suggestion = makeReferenceSuggestion({
      getPool: () => [textRow, imageRow, focusRow],
      emptyLabel: 'No references',
      imageRefsDisabled: () => hideImages,
    });
    const render = suggestion.render;
    if (!render) throw new Error('render missing');
    const handlers = render();
    const editor = makeEditor();
    // Capture the items pushed into the popup list: ReactRenderer only mounts its
    // React subtree through an EditorContent host (absent in this bare editor), so
    // the rendered options never reach the DOM — assert on the props instead.
    const updateSpy = vi.spyOn(ReactRenderer.prototype, 'updateProps');
    try {
      // t2i: the plugin computed items() → text row only (images excluded).
      handlers.onStart?.(props([textRow], editor));
      // Click the mode toggle (a control outside the editor) → hides the popup.
      document.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
      // Switch to i2i, then click back after the `@` → editor refocuses, re-show.
      hideImages = false;
      updateSpy.mockClear();
      editor.view.dom.dispatchEvent(new FocusEvent('focus'));
      // The re-show pushed a FRESH list reflecting i2i: image + focus now offered.
      const pushed = updateSpy.mock.calls.at(-1)?.[0]?.items as
        | ReferenceRailItem[]
        | undefined;
      expect(pushed?.map((r) => r.sourceNodeId).sort()).toEqual([
        'focus:c1',
        'i',
        't',
      ]);
    } finally {
      updateSpy.mockRestore();
      handlers.onExit?.(props([], editor));
      editor.destroy();
    }
  });
});

// Collaboration residuals (#1802): the `@` popup's VISIBILITY must be driven
// only by the LOCAL user's intent — a remote collaborator editing the shared
// prompt / node must refresh the list CONTENT but never resurrect a popup the
// user dismissed nor leave a visible popup stale.
describe('makeReferenceSuggestion — collaboration residuals (#1802)', () => {
  const textRow: ReferenceRailItem = {
    refId: 't->me',
    sourceNodeId: 't',
    sourceNodeType: 'text',
    sourceNodeName: 'Note',
    textContent: 'hi',
  };
  const imageRow: ReferenceRailItem = {
    refId: 'i->me',
    sourceNodeId: 'i',
    sourceNodeType: 'image',
    sourceNodeName: 'Pic',
    thumbnail: 'i.png',
  };

  type RenderHandlers = ReturnType<
    NonNullable<ReturnType<typeof makeReferenceSuggestion>['render']>
  >;
  type StartProps = Parameters<NonNullable<RenderHandlers['onStart']>>[0];
  function props(items: ReferenceRailItem[], editor: Editor): StartProps {
    return {
      editor,
      items,
      command: vi.fn(),
      clientRect: () => new DOMRect(0, 0, 10, 10),
      query: '',
      text: '',
      range: { from: 0, to: 0 },
      decorationNode: null,
    } as unknown as StartProps;
  }

  it('residual 1: a remote edit refreshes content but does NOT resurrect a dismissed popup; a local edit does', () => {
    let remote = false;
    const suggestion = makeReferenceSuggestion({
      getPool: () => [textRow],
      emptyLabel: 'No references',
      imageRefsDisabled: () => false,
      // `remote` models whether the edit was a remote peer's; the popup's
      // visibility hook is now the POSITIVE "was it a local user keystroke",
      // so inject its negation (a remote edit is not a local keystroke).
      isLocalUserInput: () => !remote,
    });
    const render = suggestion.render;
    if (!render) throw new Error('render missing');
    const handlers = render();
    const editor = makeEditor();
    const before = new Set(Array.from(document.body.children));
    const updateSpy = vi.spyOn(ReactRenderer.prototype, 'updateProps');
    try {
      handlers.onStart?.(props([textRow], editor));
      const el = Array.from(document.body.children).find(
        (c) => !before.has(c),
      ) as HTMLElement;
      expect(el.style.display).toBe(''); // shown on the fresh `@`
      // User dismisses it (clicks a panel control outside the editor + popup).
      document.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
      expect(el.style.display).toBe('none'); // hidden + dismissed
      // A REMOTE collaborator inserts before the `@` → the range shifts → onUpdate
      // fires. It must refresh CONTENT but leave the dismissed popup hidden.
      remote = true;
      updateSpy.mockClear();
      handlers.onUpdate?.(props([textRow], editor));
      expect(el.style.display).toBe('none'); // STILL hidden (residual 1 fixed)
      expect(updateSpy).toHaveBeenCalled(); // but content WAS refreshed
      // A LOCAL edit (the user re-engaging by typing) DOES re-show it.
      remote = false;
      handlers.onUpdate?.(props([textRow], editor));
      expect(el.style.display).toBe(''); // shown again
    } finally {
      updateSpy.mockRestore();
      handlers.onExit?.(props([], editor));
      editor.destroy();
    }
  });

  it('residual 1 (restart path): a REMOTE-triggered onStart does not pop a popup the user never opened', () => {
    // @tiptap/suggestion re-fires start (not just update) when a peer edit both
    // MOVES the `@` range and CHANGES the query (moved && changed). That restart
    // must not resurrect / open the popup — only a LOCAL start shows.
    let remote = false;
    const suggestion = makeReferenceSuggestion({
      getPool: () => [textRow],
      emptyLabel: 'No references',
      imageRefsDisabled: () => false,
      // `remote` models whether the edit was a remote peer's; the popup's
      // visibility hook is now the POSITIVE "was it a local user keystroke",
      // so inject its negation (a remote edit is not a local keystroke).
      isLocalUserInput: () => !remote,
    });
    const render = suggestion.render;
    if (!render) throw new Error('render missing');
    const handlers = render();
    const editor = makeEditor();
    const before = new Set(Array.from(document.body.children));
    try {
      remote = true; // the start is driven by a remote peer's edit
      handlers.onStart?.(props([textRow], editor));
      const el = Array.from(document.body.children).find(
        (c) => !before.has(c),
      ) as HTMLElement;
      expect(el.style.display).toBe('none'); // NOT shown — a peer didn't open it
      // A subsequent LOCAL edit is the user re-engaging → shows.
      remote = false;
      handlers.onUpdate?.(props([textRow], editor));
      expect(el.style.display).toBe('');
    } finally {
      handlers.onExit?.(props([], editor));
      editor.destroy();
    }
  });

  it('residual 2: refreshRef recomputes a VISIBLE popup from the live pool, and no-ops while hidden', () => {
    let pool: ReferenceRailItem[] = [textRow];
    const refreshRef: { current: (() => void) | null } = { current: null };
    const suggestion = makeReferenceSuggestion({
      getPool: () => pool,
      emptyLabel: 'No references',
      imageRefsDisabled: () => false,
      refreshRef,
      isLocalUserInput: () => true, // manual driving models a local `@` keystroke
    });
    const render = suggestion.render;
    if (!render) throw new Error('render missing');
    const handlers = render();
    const editor = makeEditor();
    const updateSpy = vi.spyOn(ReactRenderer.prototype, 'updateProps');
    try {
      handlers.onStart?.(props([textRow], editor));
      expect(typeof refreshRef.current).toBe('function'); // registered while open
      // A remote pool change lands (the pool getter now returns an image too).
      // refresh() recomputes from the LIVE pool → pushes the image row too.
      pool = [textRow, imageRow];
      updateSpy.mockClear();
      refreshRef.current?.();
      const pushed = updateSpy.mock.calls.at(-1)?.[0]?.items as
        | ReferenceRailItem[]
        | undefined;
      expect(pushed?.map((r) => r.sourceNodeId).sort()).toEqual(['i', 't']);
      // Hidden popup → refresh no-ops (nothing to refresh).
      document.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
      updateSpy.mockClear();
      refreshRef.current?.();
      expect(updateSpy).not.toHaveBeenCalled();
      // onExit clears the handle so a later prop change never pokes a dead popup.
      handlers.onExit?.(props([], editor));
      expect(refreshRef.current).toBeNull();
    } finally {
      updateSpy.mockRestore();
      editor.destroy();
    }
  });

  it('residual 2 (refill): refresh RE-SHOWS a popup it hid on a remote empty when the pool refills — not a one-way latch', () => {
    let pool: ReferenceRailItem[] = [textRow];
    const refreshRef: { current: (() => void) | null } = { current: null };
    const suggestion = makeReferenceSuggestion({
      getPool: () => pool,
      emptyLabel: 'No references',
      imageRefsDisabled: () => false,
      refreshRef,
      isLocalUserInput: () => true, // manual driving models a local `@` keystroke
    });
    const render = suggestion.render;
    if (!render) throw new Error('render missing');
    const handlers = render();
    const editor = makeEditor();
    const before = new Set(Array.from(document.body.children));
    try {
      handlers.onStart?.(props([textRow], editor));
      const el = Array.from(document.body.children).find(
        (c) => !before.has(c),
      ) as HTMLElement;
      expect(el.style.display).toBe(''); // visible, not dismissed
      // A remote edit empties the pool → refresh hides it (I3).
      pool = [];
      refreshRef.current?.();
      expect(el.style.display).toBe('none');
      // The remote edit is undone / the ref re-added → refresh must RE-SHOW it,
      // not stay latched hidden (guarded on `dismissed`, not on display).
      pool = [textRow];
      refreshRef.current?.();
      expect(el.style.display).toBe('');
    } finally {
      handlers.onExit?.(props([], editor));
      editor.destroy();
    }
  });

  it('a remote restart RESTORES an actively-open picker instead of flickering it away', () => {
    let remote = false;
    const suggestion = makeReferenceSuggestion({
      getPool: () => [textRow],
      emptyLabel: 'No references',
      imageRefsDisabled: () => false,
      // `remote` models whether the edit was a remote peer's; the popup's
      // visibility hook is now the POSITIVE "was it a local user keystroke",
      // so inject its negation (a remote edit is not a local keystroke).
      isLocalUserInput: () => !remote,
    });
    const render = suggestion.render;
    if (!render) throw new Error('render missing');
    const handlers = render();
    const editor = makeEditor();
    const before = new Set(Array.from(document.body.children));
    try {
      handlers.onStart?.(props([textRow], editor)); // local open → visible
      expect(
        (
          Array.from(document.body.children).find(
            (c) => !before.has(c),
          ) as HTMLElement
        ).style.display,
      ).toBe('');
      // A remote moved&&changed restart: onExit (captures the open state) → a
      // remote-driven onStart. The picker the user was using must be RESTORED,
      // not hidden.
      remote = true;
      handlers.onExit?.(props([textRow], editor));
      const before2 = new Set(Array.from(document.body.children));
      handlers.onStart?.(props([textRow], editor));
      const el2 = Array.from(document.body.children).find(
        (c) => !before2.has(c),
      ) as HTMLElement;
      expect(el2.style.display).toBe(''); // restored (not flickered away)
    } finally {
      handlers.onExit?.(props([], editor));
      editor.destroy();
    }
  });

  it('a GENUINE exit does not arm a later remote onStart (wasOpenBeforeExit is microtask-scoped)', async () => {
    let remote = false;
    const suggestion = makeReferenceSuggestion({
      getPool: () => [textRow],
      emptyLabel: 'No references',
      imageRefsDisabled: () => false,
      // `remote` models whether the edit was a remote peer's; the popup's
      // visibility hook is now the POSITIVE "was it a local user keystroke",
      // so inject its negation (a remote edit is not a local keystroke).
      isLocalUserInput: () => !remote,
    });
    const render = suggestion.render;
    if (!render) throw new Error('render missing');
    const handlers = render();
    const editor = makeEditor();
    try {
      handlers.onStart?.(props([textRow], editor)); // local open, visible
      // A GENUINE terminal exit (space / delete / pick), NOT an immediate restart.
      handlers.onExit?.(props([textRow], editor));
      await Promise.resolve(); // flush the microtask that clears the open flag
      // A LATER, unrelated remote `@` insertion must NOT restore/pop a picker the
      // user never opened (the stale-flag hole round 3 found).
      remote = true;
      const before = new Set(Array.from(document.body.children));
      handlers.onStart?.(props([textRow], editor));
      const el = Array.from(document.body.children).find(
        (c) => !before.has(c),
      ) as HTMLElement;
      expect(el.style.display).toBe('none'); // hidden — flag was not left armed
    } finally {
      handlers.onExit?.(props([], editor));
      editor.destroy();
    }
  });

  // The visibility discriminator is now a POSITIVE per-transaction "was the last
  // doc change a local user keystroke", not the old reverse-inference "not
  // remote" — which the round-4 adversarial pass broke: a LOCAL machine-derived
  // cascade-clear and a whitespace-normalizer follow-up both read as "not
  // remote" and wrongly resurrected a dismissed popup. These exercise the real
  // tracker plugin the ReferenceMention node installs.
  /**
   * Builds a collaborative editor carrying the ReferenceMention extension (which
   * installs the local-user-input tracker plugin) bound to a Y.Doc fragment.
   * @param doc - The backing Y.Doc.
   * @returns The editor.
   */
  function makeCollabEditor(doc: Y.Doc): Editor {
    return new Editor({
      extensions: [
        Document,
        Paragraph,
        Text,
        Collaboration.configure({ fragment: doc.getXmlFragment('prompt') }),
        ReferenceMention.configure({
          suggestion: makeReferenceSuggestion({
            getPool: () => [],
            emptyLabel: 'No references',
          }),
        }),
      ],
    });
  }

  it('flags a local keystroke true and a remote peer apply false', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const editorA = makeCollabEditor(docA);
    const editorB = makeCollabEditor(docB);
    try {
      editorA.commands.insertContent('local');
      expect(wasLastChangeLocalUserInput(editorA)).toBe(true);
      // B types, then B's state syncs into A → y-prosemirror applies it as a
      // remote change (tagged with the y-sync plugin key's meta).
      editorB.commands.insertContent('peer');
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
      expect(wasLastChangeLocalUserInput(editorA)).toBe(false);
    } finally {
      editorA.destroy();
      editorB.destroy();
    }
  });

  it('flags a MACHINE-derived local dispatch false (round-4: an edge-driven cascade-clear before an @ looked local)', () => {
    const docA = new Y.Doc();
    const editorA = makeCollabEditor(docA);
    try {
      editorA.commands.insertContent('seed');
      expect(wasLastChangeLocalUserInput(editorA)).toBe(true);
      // The edge-driven cascade-clear dispatches a LOCAL tr tagged
      // MACHINE_EDIT_META — it changes the doc but is not a keystroke. The old
      // "not remote" test wrongly counted it as local and resurrected the popup.
      const tr = editorA.state.tr.insertText('!', 1);
      tr.setMeta(MACHINE_EDIT_META, true);
      editorA.view.dispatch(tr);
      expect(wasLastChangeLocalUserInput(editorA)).toBe(false);
    } finally {
      editorA.destroy();
    }
  });

  it('a follow-up appendedTransaction does not override the root judgment (round-4: a whitespace-normalizer after a remote edit stayed non-local)', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const editorA = makeCollabEditor(docA);
    const editorB = makeCollabEditor(docB);
    try {
      editorB.commands.insertContent('peer');
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
      expect(wasLastChangeLocalUserInput(editorA)).toBe(false);
      // A machine follow-up appended by another plugin's appendTransaction rides
      // WITH that remote root (ProseMirror tags it `appendedTransaction`). It must
      // not flip the judgment back to local — the settled-state hole round 4 found.
      const followUp = editorA.state.tr.insertText('x', 1);
      followUp.setMeta('appendedTransaction', editorA.state.tr);
      editorA.view.dispatch(followUp);
      expect(wasLastChangeLocalUserInput(editorA)).toBe(false);
    } finally {
      editorA.destroy();
      editorB.destroy();
    }
  });

  it('a local yUndo is not a keystroke (undo does not re-show a dismissed popup)', () => {
    const docA = new Y.Doc();
    const editorA = makeCollabEditor(docA);
    try {
      editorA.commands.insertContent('typed');
      expect(wasLastChangeLocalUserInput(editorA)).toBe(true);
      editorA.commands.undo(); // yUndo — carries the y-sync key's meta, not a keystroke
      expect(wasLastChangeLocalUserInput(editorA)).toBe(false);
    } finally {
      editorA.destroy();
    }
  });

  it('end-to-end: a machine-derived transaction through the REAL tracker keeps a dismissed popup hidden, and a real keystroke re-shows it (round-6 test-gap)', () => {
    // Drives the WHOLE chain with NO injected isLocalUserInput: a machine-tagged
    // dispatch advances the real tracker plugin, and the suggestion's onUpdate
    // reads it via the default wasLastChangeLocalUserInput. A wiring break (onUpdate
    // reading the wrong predicate, or the tracker mis-judging the machine tr) fails
    // HERE — where the split "gating given a signal" and "tracker return value"
    // tests would each still pass.
    const docA = new Y.Doc();
    const editor = makeCollabEditor(docA);
    const suggestion = makeReferenceSuggestion({
      getPool: () => [textRow],
      emptyLabel: 'No references',
    }); // no isLocalUserInput → the real tracker drives visibility
    const render = suggestion.render;
    if (!render) throw new Error('render missing');
    const handlers = render();
    const before = new Set(Array.from(document.body.children));
    try {
      // A local keystroke advances the tracker to "local" → onStart shows.
      editor.commands.insertContent('a');
      handlers.onStart?.(props([textRow], editor));
      const el = Array.from(document.body.children).find(
        (c) => !before.has(c),
      ) as HTMLElement;
      expect(el.style.display).toBe('');
      // User dismisses (clicks a panel control outside).
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      expect(el.style.display).toBe('none');
      // The edge-driven cascade-clear: a machine-tagged local dispatch shifting
      // the range → onUpdate. Through the REAL tracker it reads non-local, so the
      // dismissed popup stays hidden (content still refreshes).
      const machineTr = editor.state.tr.insertText('x', 1);
      machineTr.setMeta(MACHINE_EDIT_META, true);
      editor.view.dispatch(machineTr);
      handlers.onUpdate?.(props([textRow], editor));
      expect(el.style.display).toBe('none'); // still hidden — end-to-end
      // A genuine local keystroke DOES re-show it (proves it is not latched hidden).
      editor.commands.insertContent('b');
      handlers.onUpdate?.(props([textRow], editor));
      expect(el.style.display).toBe('');
    } finally {
      handlers.onExit?.(props([], editor));
      editor.destroy();
    }
  });

  it('a real caret appendTransaction after a remote chip insert stays non-local (round-6 test-gap: guard vs a genuine PM append)', () => {
    // Round-4 finding 2 relied on a real appendTransaction, not a hand-set meta:
    // a peer inserts a BARE chip; synced into A, the caret plugin's
    // appendTransaction (appendWhitespace) fires on A to restore the invariant
    // flanking spaces — a genuine PM-tagged appendedTransaction riding with the
    // remote root. The guard must keep the judgment non-local; without it, the
    // local space-insert would flip it to "user typed".
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const editorA = makeCollabEditor(docA);
    const editorB = makeCollabEditor(docB);
    try {
      editorB.commands.insertContent(referenceMentionContent(imageRow));
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
      // The whitespace normalizer ran on A → the chip is now flanked by spaces,
      // proving a real appended transaction was applied (not a no-op).
      expect(editorA.getText()).toContain(' ');
      expect(wasLastChangeLocalUserInput(editorA)).toBe(false);
    } finally {
      editorA.destroy();
      editorB.destroy();
    }
  });

  it('dispatchMachineEdit tags a machine effect non-local through the real tracker (round-6 test-gap: asserts the tag at its PRODUCER)', () => {
    // The machine-edit tag lives at ONE producer (dispatchMachineEdit); the
    // cascade-clear and chip display sync both dispatch through it. Deleting the
    // MACHINE_EDIT_META tag inside dispatchMachineEdit turns this red — the
    // round-6 gap was that the tag was only ever exercised by the tracker
    // consuming a hand-set meta, never asserted at the producer that emits it.
    const editor = makeCollabEditor(new Y.Doc());
    try {
      editor.commands.insertContent('seed'); // local keystroke → tracker true
      expect(wasLastChangeLocalUserInput(editor)).toBe(true);
      const tr = editor.state.tr.insertText('!', 1);
      dispatchMachineEdit(editor.view, tr);
      expect(wasLastChangeLocalUserInput(editor)).toBe(false); // non-local via producer
    } finally {
      editor.destroy();
    }
  });
});

// Text-chip serialization (spec §9.1, user 2026-07-10): the chip STAYS a chip
// in the editor; only the backend-bound prompt string substitutes a text chip
// with the source text node's CURRENT content. An image chip contributes
// nothing to the string (it feeds the i2i source subset, not the prompt).
describe('serializePromptText — backend prompt string with text-chip substitution', () => {
  const textRef: ReferenceRailItem = {
    refId: 'txt->me',
    sourceNodeId: 'txt',
    sourceNodeType: 'text',
    sourceNodeName: 'Notes',
    textContent: 'a red panda on a bike',
  };
  const imageRef: ReferenceRailItem = {
    refId: 'img->me',
    sourceNodeId: 'img',
    sourceNodeType: 'image',
    sourceNodeName: 'Pic',
    thumbnail: 'x.png',
  };

  /**
   * Mounts an editor and seeds it with `draw` + text chip + image chip.
   * @returns The editor (caller destroys).
   */
  function seededEditor(): Editor {
    const editor = makeEditor();
    editor
      .chain()
      .insertContent('draw ')
      .insertContent(referenceMentionContent(textRef))
      .insertContent(' next to ')
      .insertContent(referenceMentionContent(imageRef))
      .run();
    return editor;
  }

  it('substitutes a text chip with the source node content and drops an image chip', () => {
    const editor = seededEditor();
    try {
      const out = serializePromptText(editor, [textRef, imageRef]);
      // Extra trailing space: the image chip sits at paragraph end, so the
      // whitespace invariant adds a space after it (design 2026-07-13 §8 —
      // chip-flanking spaces enter the serialized string; the execute gate
      // trims, so a whitespace-only prompt stays non-executable).
      expect(out).toBe('draw a red panda on a bike next to  ');
    } finally {
      editor.destroy();
    }
  });

  it('reads the CURRENT pool content (a later edit of the text node lands in the string)', () => {
    const editor = seededEditor();
    try {
      const edited = { ...textRef, textContent: 'a blue whale' };
      expect(serializePromptText(editor, [edited, imageRef])).toBe(
        'draw a blue whale next to  ',
      );
    } finally {
      editor.destroy();
    }
  });

  it('substitutes an empty string for a text chip whose node is empty or no longer in the pool', () => {
    const editor = seededEditor();
    try {
      // Pool row gone (edge removed between report and read) → no content.
      expect(serializePromptText(editor, [imageRef])).toBe(
        'draw  next to  ',
      );
    } finally {
      editor.destroy();
    }
  });
});

// Cross-node paste (E, user 2026-07-12): copying a chip from node A's prompt
// into node B — which is NOT wired to that source — must drop the chip (a chip
// means "this node references that source"), keeping the surrounding words. A
// chip whose source IS in the target pool (same-node paste) survives.
describe('stripForeignReferenceChips — cross-node paste', () => {
  const chip = (id: string): ReferenceRailItem => ({
    refId: `${id}->x`,
    sourceNodeId: id,
    sourceNodeType: 'image',
    sourceNodeName: id,
    thumbnail: `${id}.png`,
  });

  it('drops chips whose source is not in the target pool, keeps in-pool chips and text', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent(referenceMentionContent(chip('A')))
        .insertContent('hi')
        .insertContent(referenceMentionContent(chip('B')))
        .run();
      const slice = editor.state.doc.slice(0, editor.state.doc.content.size);
      const stripped = stripForeignReferenceChips(slice, new Set(['A']));
      let chips = 0;
      let text = '';
      stripped.content.descendants((n) => {
        if (n.type.name === REFERENCE_MENTION_NODE) chips += 1;
        if (n.isText) text += n.text ?? '';
        return true;
      });
      expect(chips).toBe(1); // only A (in pool) survives; B (foreign) dropped
      // The chip-flanking whitespace invariant put spaces around A/B in the
      // source doc, so the kept text carries them (design 2026-07-13 §8).
      expect(text).toBe('  hi  '); // surrounding text kept (with invariant spaces)
    } finally {
      editor.destroy();
    }
  });

  it('keeps every chip when all sources are in the pool (same-node paste)', () => {
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent(referenceMentionContent(chip('A')))
        .insertContent(referenceMentionContent(chip('B')))
        .run();
      const slice = editor.state.doc.slice(0, editor.state.doc.content.size);
      const stripped = stripForeignReferenceChips(slice, new Set(['A', 'B']));
      let chips = 0;
      stripped.content.descendants((n) => {
        if (n.type.name === REFERENCE_MENTION_NODE) chips += 1;
        return true;
      });
      expect(chips).toBe(2);
    } finally {
      editor.destroy();
    }
  });

  // The paste pool-membership invariant is MODALITY-AGNOSTIC (design 2026-07-12;
  // batch-5 I6): stripping keys off the REFERENCE_MENTION node type + source id,
  // never the modality, so a foreign TEXT chip is dropped and an in-pool text
  // chip survives exactly like an image chip. This is the paste-side twin of the
  // live-projection invariant the display sync enforces.
  it('drops a foreign TEXT chip and keeps an in-pool text chip (modality-agnostic)', () => {
    const textChip = (id: string): ReferenceRailItem => ({
      refId: `${id}->x`,
      sourceNodeId: id,
      sourceNodeType: 'text',
      sourceNodeName: id,
      textContent: `body of ${id}`,
    });
    const editor = makeEditor();
    try {
      editor
        .chain()
        .insertContent(referenceMentionContent(textChip('T1'))) // in pool
        .insertContent('mid')
        .insertContent(referenceMentionContent(textChip('T2'))) // foreign
        .run();
      const slice = editor.state.doc.slice(0, editor.state.doc.content.size);
      const stripped = stripForeignReferenceChips(slice, new Set(['T1']));
      let chips = 0;
      let text = '';
      stripped.content.descendants((n) => {
        if (n.type.name === REFERENCE_MENTION_NODE) chips += 1;
        if (n.isText) text += n.text ?? '';
        return true;
      });
      expect(chips).toBe(1); // T1 survives, foreign T2 dropped
      expect(text).toBe('  mid  '); // kept text carries the invariant spaces (§8)
    } finally {
      editor.destroy();
    }
  });
});
