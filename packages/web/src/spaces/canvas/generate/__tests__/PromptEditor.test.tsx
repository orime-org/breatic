// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  renderCollabCaret,
  renderCollabSelection,
} from '@web/spaces/canvas/generate/caret-render';
import {
  PromptEditor,
  type PromptEditorHandle,
} from '@web/spaces/canvas/generate/PromptEditor';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

/** Reads the empty paragraph's data-placeholder (what the Placeholder ext renders). */
function currentPlaceholder(): string | null {
  return document
    .querySelector('.ProseMirror p')
    ?.getAttribute('data-placeholder') ?? null;
}

describe('PromptEditor — collaborative plain-text prompt (slice 1)', () => {
  it('mounts an editor bound to the given prompt fragment and reports its text', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    const onTextChange = vi.fn();
    const onAtMentionsChange = vi.fn();

    render(
      <PromptEditor
        fragment={fragment}
        placeholder='Describe the image'
        onTextChange={onTextChange}
        onAtMentionsChange={onAtMentionsChange}
        references={[]}
        mode='t2i'
        mentionEmptyLabel='No references'
      />,
    );

    // The editor container renders; the editor mounts asynchronously
    // (immediatelyRender: false), after which onTextChange fires from onCreate.
    expect(screen.getByTestId('generate-prompt-editor')).toBeInTheDocument();
    await waitFor(() => expect(onTextChange).toHaveBeenCalled());
    // The `@`-mention reporter fires alongside the text; an empty prompt picks
    // nothing, so it reports an empty source-id list.
    expect(onAtMentionsChange).toHaveBeenCalledWith([]);
  });

  it('re-syncs the placeholder when it changes mid-panel (in-session locale switch)', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    const props = {
      fragment,
      onTextChange: vi.fn(),
      onAtMentionsChange: vi.fn(),
      references: [],
      mode: 't2i' as const,
      mentionEmptyLabel: 'No references',
    };

    const { rerender } = render(
      <PromptEditor {...props} placeholder='Describe the image' />,
    );
    await waitFor(() =>
      expect(currentPlaceholder()).toBe('Describe the image'),
    );

    // A locale switch re-renders PromptEditor with the new-language string but
    // does NOT change the fragment. The editor must re-sync (not stay stuck on
    // the old language until the panel is reopened) — adversarial round-2.
    rerender(<PromptEditor {...props} placeholder='画像を説明' />);
    await waitFor(() => expect(currentPlaceholder()).toBe('画像を説明'));
  });

  // t2i grey-out scope (round-2 adversarial): the dim pre-announces "this
  // reference will not take effect in t2i" — TRUE for image chips (execute
  // forces referenceUrls=[] in t2i) but FALSE for text chips (their
  // substitution still feeds the prompt string and the submitted payload).
  // The dim selector must therefore target image chips only.
  it('t2i dims only IMAGE chips (text substitutions still take effect)', () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    render(
      <PromptEditor
        fragment={fragment}
        placeholder='Describe'
        onTextChange={vi.fn()}
        onAtMentionsChange={vi.fn()}
        references={[]}
        mode='t2i'
        mentionEmptyLabel='No references'
      />,
    );
    // The dim classes live on the ScrollArea VIEWPORT (#1773) — the element
    // whose padding/content styles scroll with the prompt.
    const viewport = screen
      .getByTestId('generate-prompt-editor')
      .querySelector('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    const cls = (viewport as HTMLElement).className;
    expect(cls).toContain('[data-kind=image]');
    expect(cls).not.toMatch(/\[&_\.reference-mention\]:opacity/);
  });

  // Execute-gate mirror freshness (round-2 adversarial): a text chip's
  // substitution reads the SOURCE NODE's content, which can change without any
  // prompt-document edit (the user types into the text node on the canvas).
  // The reported prompt text must re-sync when the pool changes, or the
  // execute button stays stuck on the stale substitution (empty node @-ed →
  // button dead forever; emptied node → button lit but execute silently
  // no-ops).
  it('re-reports the substituted prompt text when a referenced text node content changes', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    const onTextChange = vi.fn();
    const textRef = (content: string): ReferenceRailItem => ({
      refId: 'txt->me',
      sourceNodeId: 'txt',
      sourceNodeType: 'text',
      sourceNodeName: 'Notes',
      textContent: content,
    });
    const ref = React.createRef<PromptEditorHandle>();
    const props = {
      fragment,
      placeholder: 'Describe',
      onTextChange,
      onAtMentionsChange: vi.fn(),
      mode: 'i2i' as const,
      mentionEmptyLabel: 'No references',
    };
    const { rerender } = render(
      <PromptEditor {...props} ref={ref} references={[textRef('')]} />,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current?.insertReference(textRef(''));
    });
    // The empty text node substitutes to '' — but the chip is flanked by the
    // whitespace-invariant spaces, so the reported string is those spaces
    // (design 2026-07-13 §8; the execute gate trims, so it stays non-executable).
    await waitFor(() =>
      expect(onTextChange).toHaveBeenLastCalledWith('  '),
    );
    // The user types into the text node ON THE CANVAS: the prompt document
    // never changes, only the pool row's textContent does.
    rerender(
      <PromptEditor {...props} ref={ref} references={[textRef('a red fox')]} />,
    );
    await waitFor(() =>
      expect(onTextChange).toHaveBeenLastCalledWith(' a red fox '),
    );
  });

  it('cascade-clears a chip AND its flanking spaces when its edge leaves the pool (no orphan)', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    const onTextChange = vi.fn();
    const imgRef = (): ReferenceRailItem => ({
      refId: 'e->me',
      sourceNodeId: 'e',
      sourceNodeType: 'image',
      sourceNodeName: 'E',
      thumbnail: 'e.png',
    });
    const ref = React.createRef<PromptEditorHandle>();
    const props = {
      fragment,
      placeholder: 'Describe',
      onTextChange,
      onAtMentionsChange: vi.fn(),
      mode: 'i2i' as const,
      mentionEmptyLabel: 'No references',
    };
    const { rerender } = render(
      <PromptEditor {...props} ref={ref} references={[imgRef()]} />,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current?.insertReference(imgRef());
    });
    // Image chip contributes no text; flanked by the invariant spaces → '  '.
    await waitFor(() => expect(onTextChange).toHaveBeenLastCalledWith('  '));
    // The edge leaves the pool → the cascade must remove the chip AND its spaces,
    // not just the chip node (adversarial finding). Serialized text back to ''.
    rerender(<PromptEditor {...props} ref={ref} references={[]} />);
    await waitFor(() => expect(onTextChange).toHaveBeenLastCalledWith(''));
  });
});

// Remote collaborator carets (batch-2 item 14, CRITICAL PATH — Yjs collab):
// the prompt editor mounts the CollaborationCaret extension when the canvas-
// space doc's provider (awareness) is supplied, publishing this user's
// identity (name + deterministic palette color) and rendering other clients'
// carets. Without a provider (e.g. the socket has not connected yet) the
// extension must be ABSENT — it throws in onCreate when provider is null.
describe('PromptEditor — collaborator carets (awareness)', () => {
  /**
   * Mounts the editor with an optional caret provider built on a REAL
   * y-protocols Awareness over the fragment's own doc.
   * @param withProvider - Whether to supply the awareness provider.
   * @returns The awareness (to inspect the published local state).
   */
  async function mountWithAwareness(
    withProvider: boolean,
  ): Promise<{ awareness: Awareness; editorEl: HTMLElement }> {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    // Pre-populate the shared fragment: y-prosemirror renders NO cursor
    // decorations while its binding mapping is empty (createDecorations
    // bails on mapping.size === 0), so an empty prompt cannot host a caret.
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('hello world')]);
    fragment.insert(0, [paragraph]);
    const awareness = new Awareness(doc);
    render(
      <PromptEditor
        fragment={fragment}
        placeholder='p'
        onTextChange={vi.fn()}
        onAtMentionsChange={vi.fn()}
        references={[]}
        mode='t2i'
        mentionEmptyLabel='none'
        caretProvider={withProvider ? { awareness } : null}
        caretUser={{ name: 'Ada', color: '#008573', hue: 'teal' }}
      />,
    );
    const editorEl = screen.getByTestId('generate-prompt-editor');
    await waitFor(() =>
      expect(editorEl.querySelector('.ProseMirror')).not.toBeNull(),
    );
    return { awareness, editorEl };
  }

  it('publishes the local user identity into awareness when the provider is supplied', async () => {
    const { awareness } = await mountWithAwareness(true);
    await waitFor(() => {
      const local = awareness.getLocalState() as {
        user?: { name: string; color: string };
      } | null;
      // The published color is a concrete 6-digit hex (y-prosemirror's
      // validator warns on anything else); the hue rides along so receiving
      // breatic clients render the viewer-theme-adaptive palette token, and
      // `focused` seeds from the REAL document.hasFocus() on mount (its jsdom
      // value depends on what earlier tests focused — assert the type only).
      expect(local?.user).toMatchObject({
        name: 'Ada',
        color: '#008573',
        hue: 'teal',
      });
      expect(typeof (local?.user as { focused?: unknown })?.focused).toBe('boolean');
    });
  });

  it('publishes focused=false on window blur and true on focus (item 4)', async () => {
    const { awareness } = await mountWithAwareness(true);
    /**
     * Reads the published focus flag from the local awareness state.
     * @returns The `user.focused` field.
     */
    const focusedField = (): boolean | undefined =>
      (awareness.getLocalState() as { user?: { focused?: boolean } } | null)
        ?.user?.focused;
    // Don't assume the seed (document.hasFocus() is environment-dependent):
    // drive to a known state first, then flip both ways.
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    await waitFor(() => expect(focusedField()).toBe(false));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(focusedField()).toBe(true));
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    await waitFor(() => expect(focusedField()).toBe(false));
  });

  it('dims and un-dims a PARKED remote caret when its client flips focused (receiver side)', async () => {
    const { awareness, editorEl } = await mountWithAwareness(true);
    const doc = awareness.doc;
    const fragment = doc.getXmlFragment('prompt');
    const text = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const anchor = Y.createRelativePositionFromTypeIndex(text, 3);
    const REMOTE_CLIENT = awareness.clientID + 1;
    /**
     * Pushes the remote client's state (fixed parked cursor) through the
     * awareness change pipeline with the given focus flag.
     * @param focused - The remote client's published focus state.
     */
    const pushRemote = (focused: boolean): void => {
      const states = new Map(awareness.getStates());
      states.set(REMOTE_CLIENT, {
        user: { name: 'Grace', color: '#c2298a', hue: 'pink', focused },
        cursor: {
          anchor: JSON.parse(JSON.stringify(Y.relativePositionToJSON(anchor))) as unknown,
          head: JSON.parse(JSON.stringify(Y.relativePositionToJSON(anchor))) as unknown,
        },
      });
      act(() => {
        awareness.states = states;
        awareness.emit('change', [
          { added: [], updated: [REMOTE_CLIENT], removed: [] },
          'remote',
        ]);
      });
    };
    pushRemote(true);
    await waitFor(() =>
      expect(editorEl.querySelector('.collaboration-carets__caret')).not.toBeNull(),
    );
    const caret = (): Element | null =>
      editorEl.querySelector('.collaboration-carets__caret');
    expect(caret()?.classList.contains('collaboration-carets__caret--blurred')).toBe(false);
    // The PARKED caret's widget DOM is reused on key equality (builder never
    // re-invoked) — the awareness listener must toggle the class in place.
    pushRemote(false);
    await waitFor(() =>
      expect(
        caret()?.classList.contains('collaboration-carets__caret--blurred'),
      ).toBe(true),
    );
    pushRemote(true);
    await waitFor(() =>
      expect(
        caret()?.classList.contains('collaboration-carets__caret--blurred'),
      ).toBe(false),
    );
  });

  it('keeps the dim after a local transaction rebuilds the caret from a stale thunk (resurrection race)', async () => {
    const { awareness, editorEl } = await mountWithAwareness(true);
    const doc = awareness.doc;
    const fragment = doc.getXmlFragment('prompt');
    const text = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const anchor = Y.createRelativePositionFromTypeIndex(text, 3);
    const REMOTE_CLIENT = awareness.clientID + 1;
    /**
     * Pushes the remote client's parked-cursor state with the given focus flag.
     * @param focused - The remote client's published focus state.
     */
    const pushRemote = (focused: boolean): void => {
      const states = new Map(awareness.getStates());
      states.set(REMOTE_CLIENT, {
        user: { name: 'Grace', color: '#c2298a', hue: 'pink', focused },
        cursor: {
          anchor: JSON.parse(JSON.stringify(Y.relativePositionToJSON(anchor))) as unknown,
          head: JSON.parse(JSON.stringify(Y.relativePositionToJSON(anchor))) as unknown,
        },
      });
      act(() => {
        awareness.states = states;
        awareness.emit('change', [
          { added: [], updated: [REMOTE_CLIENT], removed: [] },
          'remote',
        ]);
      });
    };
    pushRemote(true);
    await waitFor(() =>
      expect(editorEl.querySelector('.collaboration-carets__caret')).not.toBeNull(),
    );
    // Reaching the STALE-thunk branch needs precise staging (adversarial R3 —
    // a Y-origin doc.transact recreates decorations from CURRENT awareness and
    // can never exercise it, which made the first version of this test pass
    // even with the fix deleted):
    // 1. park the batched yCursor refresh with fake timers, so the flip's
    //    fresh decorations never land;
    // 2. flip focused=false — the awareness handler dims the existing DOM;
    // 3. dispatch a PM-SIDE structural transaction (split forces the widget's
    //    parent desc to rebuild; plain insertText reuses the widget DOM) —
    //    the widget rebuilds from the PRE-FLIP thunk (focused=true), and only
    //    the transaction resync re-dims it: this assertion goes RED without
    //    editor.on('transaction', applyDim);
    // 4. release the batched refresh — key-equality DOM reuse must not
    //    resurrect the pre-flip class either.
    vi.useFakeTimers();
    try {
      pushRemote(false);
      const blurred = (): boolean | undefined =>
        editorEl
          .querySelector('.collaboration-carets__caret')
          ?.classList.contains('collaboration-carets__caret--blurred');
      expect(blurred()).toBe(true); // awareness-handler path
      const editor = (
        editorEl.querySelector('.ProseMirror') as unknown as {
          editor: { view: { dispatch: (tr: unknown) => void; state: { tr: { split: (pos: number) => unknown } } } };
        }
      ).editor;
      act(() => {
        editor.view.dispatch(editor.view.state.tr.split(2));
      });
      expect(blurred()).toBe(true); // stale-thunk rebuild, re-dimmed by the resync
      act(() => {
        vi.runOnlyPendingTimers(); // batched yCursor refresh (DOM reuse path)
      });
      expect(blurred()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a remote client caret with the remote user name and color', async () => {
    const { awareness, editorEl } = await mountWithAwareness(true);
    // Simulate ANOTHER client on the same doc: y-prosemirror keys remote
    // carets by awareness client id + that client's cursor (relative anchor
    // into the shared fragment type).
    const doc = awareness.doc;
    const fragment = doc.getXmlFragment('prompt');
    // Anchor INSIDE the pre-populated text (a position the ySync mapping can
    // translate into the ProseMirror doc).
    const text = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const anchor = Y.createRelativePositionFromTypeIndex(text, 3);
    const REMOTE_CLIENT = awareness.clientID + 1;
    const states = new Map(awareness.getStates());
    states.set(REMOTE_CLIENT, {
      user: { name: 'Grace', color: '#c2298a', hue: 'pink' },
      cursor: {
        anchor: JSON.parse(
          JSON.stringify(Y.relativePositionToJSON(anchor)),
        ) as unknown,
        head: JSON.parse(
          JSON.stringify(Y.relativePositionToJSON(anchor)),
        ) as unknown,
      },
    });
    // Push the synthetic remote state through the awareness change pipeline.
    act(() => {
      awareness.states = states;
      awareness.emit('change', [
        { added: [REMOTE_CLIENT], updated: [], removed: [] },
        'remote',
      ]);
    });
    await waitFor(() => {
      const caret = editorEl.querySelector('.collaboration-carets__caret');
      expect(caret).not.toBeNull();
      const label = caret?.querySelector('.collaboration-carets__label');
      expect(label?.textContent).toBe('Grace');
      // Receiver-side rendering resolves the WHITELISTED hue to the palette
      // token var — the viewer's own theme picks the light/dark value. The
      // raw remote color string is never inlined when a valid hue exists
      // (style-attribute injection from a hostile collaborator).
      expect(label?.getAttribute('style')).toContain(
        'var(--color-palette-pink)',
      );
    });
  });

  it('wires BOTH safe builders into the caret extension (cursor render + selection render)', async () => {
    const { editorEl } = await mountWithAwareness(true);
    // Runtime binding, not source text: the mounted extension instance must
    // carry the hardened builders — the default selectionRender inlines the
    // raw remote user.color (adversarial round-1 HIGH).
    const pm = editorEl.querySelector('.ProseMirror');
    expect(pm).not.toBeNull();
    // Resolve the live editor through the TipTap element binding.
    const editor = (
      pm as unknown as { editor?: { extensionManager: { extensions: Array<{ name: string; options: Record<string, unknown> }> } } }
    ).editor;
    const caretExt = editor?.extensionManager.extensions.find(
      (e) => e.name === 'collaborationCaret',
    );
    expect(caretExt).toBeDefined();
    expect(caretExt?.options.render).toBe(renderCollabCaret);
    expect(caretExt?.options.selectionRender).toBe(renderCollabSelection);
  });

  it('mounts NO caret extension without a provider (the extension throws on null)', async () => {
    const { editorEl } = await mountWithAwareness(false);
    // The editor is alive and usable...
    expect(editorEl.querySelector('.ProseMirror')).not.toBeNull();
    // ...and no caret machinery is present.
    expect(editorEl.querySelector('.collaboration-carets__caret')).toBeNull();
  });
});

// The caret / label classes come from the extension's default render; their
// look lives in index.css. Block-scoped regexes (R4 lesson: substring-
// anywhere assertions are gameable) pin that both blocks exist and carry the
// load-bearing properties.
describe('collaboration caret CSS contract (index.css)', () => {
  const css = readFileSync(resolve(__dirname, '../../../../index.css'), 'utf8');

  it('draws the remote caret line', () => {
    expect(css).toMatch(
      /\.collaboration-carets__caret\s*\{[^}]*border-left:[^}]*\}/,
    );
  });

  it('floats the name label above the caret in the user color', () => {
    expect(css).toMatch(
      /\.collaboration-carets__label\s*\{[^}]*position:\s*absolute[^}]*\}/,
    );
  });
});
