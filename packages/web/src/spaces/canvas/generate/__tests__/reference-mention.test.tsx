// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { SuggestionPluginKey } from '@tiptap/suggestion';

import {
  ReferenceMention,
  referenceMentionContent,
  serializePromptText,
  stripForeignReferenceChips,
} from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
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
