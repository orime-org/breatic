// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi } from 'vitest';
import {
  act,
  render as baseRender,
  screen,
  waitFor,
} from '@testing-library/react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';

// The prompt's `@` chips inherit the ONE app-level TooltipProvider at runtime
// (App.tsx); supply the real Radix provider here (single-provider mandate).
const render = (
  ...args: Parameters<typeof baseRender>
): ReturnType<typeof baseRender> =>
  // wrapper option (not a manual wrap) so a later rerender() keeps the provider
  // — the substituted-text test rerenders the editor, which nests `@` chips.
  baseRender(args[0], { ...args[1], wrapper: TooltipProvider });
import * as React from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { userPaletteHue } from '@web/lib/user-color';
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
        imageRefsDisabled
        mentionEmptyLabel='No references'
        mentionNoMatchLabel='No matches'
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
      imageRefsDisabled: true,
      mentionEmptyLabel: 'No references',
      mentionNoMatchLabel: 'No matches',
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
        imageRefsDisabled
        mentionEmptyLabel='No references'
        mentionNoMatchLabel='No matches'
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
      imageRefsDisabled: false,
      mentionEmptyLabel: 'No references',
      mentionNoMatchLabel: 'No matches',
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
      imageRefsDisabled: false,
      mentionEmptyLabel: 'No references',
      mentionNoMatchLabel: 'No matches',
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
    // The cascade dispatches through dispatchMachineEdit (machine-tagged so it
    // never resurrects a dismissed popup); that tagging is unit-tested against
    // the real tracker in reference-mention.test.tsx.
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
      <CollaboratorNamesProvider
        value={{
          // Stands in for the project roster the page publishes (#1882).
          resolve: (userId: string) => (userId === 'u-grace' ? 'Grace' : null),
          members: [],
        }}
      >
        <PromptEditor
          fragment={fragment}
          placeholder='p'
          onTextChange={vi.fn()}
          onAtMentionsChange={vi.fn()}
          references={[]}
          imageRefsDisabled
          mentionEmptyLabel='none'
          mentionNoMatchLabel='No matches'
          caretProvider={withProvider ? { awareness } : null}
        />
      </CollaboratorNamesProvider>,
    );
    const editorEl = screen.getByTestId('generate-prompt-editor');
    await waitFor(() =>
      expect(editorEl.querySelector('.ProseMirror')).not.toBeNull(),
    );
    return { awareness, editorEl };
  }

  it('publishes the focus flag and no identity when the provider is supplied', async () => {
    const { awareness } = await mountWithAwareness(true);
    await waitFor(() => {
      const local = awareness.getLocalState() as {
        user?: Record<string, unknown>;
      } | null;
      // Nothing about who this is (#1886): the server writes the id from the
      // credential this connection presented, and receivers resolve the name
      // from the project roster and the colour from that id.
      // `focused` seeds from the REAL document.hasFocus() on mount (its jsdom
      // value depends on what earlier tests focused — assert the type only).
      expect(local?.user).not.toHaveProperty('id');
      expect(typeof local?.user?.focused).toBe('boolean');
      expect(local?.user).not.toHaveProperty('name');
      expect(local?.user).not.toHaveProperty('color');
      expect(local?.user).not.toHaveProperty('hue');
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

  it('a local structural edit hides the parked remote caret, and it comes back still dimmed', async () => {
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
    // 1. The peer goes away. The awareness handler dims the EXISTING caret DOM
    //    (prosemirror-view reuses a widget whose key is unchanged without
    //    re-invoking its builder, so nothing else would dim it).
    pushRemote(false);
    const caretEl = (): Element | null =>
      editorEl.querySelector('.collaboration-carets__caret');
    const blurred = (): boolean | undefined =>
      caretEl()?.classList.contains('collaboration-carets__caret--blurred');
    await waitFor(() => expect(blurred()).toBe(true));

    // 2. A local STRUCTURAL edit. Since @tiptap/y-tiptap 3.0.7 the cursor plugin
    //    drops every remote decoration on one, because the ProseMirror document
    //    leads the Yjs mapping and a parked position would render in the wrong
    //    place. Upstream then waits for the collaborator to republish — which an
    //    idle peer never does, since its deep-equal heartbeats fire 'update' and
    //    not 'change'. Left alone, pressing Enter makes every collaborator's
    //    caret vanish until they happen to move.
    const editor = (
      editorEl.querySelector('.ProseMirror') as unknown as {
        editor: { view: { dispatch: (tr: unknown) => void; state: { tr: { split: (pos: number) => unknown } } } };
      }
    ).editor;
    act(() => {
      editor.view.dispatch(editor.view.state.tr.split(2));
    });

    // 3. The peer does NOTHING. The caret must come back anyway, and come back
    //    dimmed — the collaborator is still away. Real timers throughout: the
    //    point is that the recovery happens on its own, not that a parked timer
    //    can be released by hand.
    await waitFor(() => expect(caretEl()).not.toBeNull(), { timeout: 2000 });
    expect(blurred()).toBe(true);
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
      user: { id: 'u-grace' },
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
      // The name came from the roster resolver, not from the wire (#1882):
      // the remote client published nothing but `{ id: 'u-grace' }`.
      expect(label?.textContent).toBe('Grace');
      // The colour is derived from that same id, resolving to a palette token
      // var so the viewer's own theme picks the light/dark value. No remote
      // string reaches the style attribute at all any more.
      expect(label?.getAttribute('style')).toContain(
        `var(--color-palette-${userPaletteHue('u-grace')})`,
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
    // Asserted by BEHAVIOUR, not by function identity: `render` is now a
    // closure so the name resolver can be threaded in (#1882 — upstream's
    // signature has nowhere to put a third argument). Comparing references
    // would have failed on that wrapper while the wiring was perfectly fine,
    // and — worse — would pass on a wrapper that forgot to call through.
    const render = caretExt?.options.render as (
      user: { id: string },
      clientId?: number,
    ) => HTMLElement;
    const caret = render({ id: 'u-remote' }, 5);
    expect(caret.classList.contains('collaboration-carets__caret')).toBe(true);
    expect(caret.style.borderColor).toContain('var(--color-palette-');
    expect(caret.dataset.clientId).toBe('5');

    const selectionRender = caretExt?.options.selectionRender as (u: {
      id: string;
    }) => { style: string; class: string };
    const attrs = selectionRender({ id: 'u-remote' });
    expect(attrs.class).toBe('collaboration-carets__selection');
    // The hardened part: a custom property, never a raw background-color —
    // the default builder inlines the remote colour (adversarial round-1 HIGH).
    expect(attrs.style).toContain('--collab-selection-bg:');
    expect(attrs.style).not.toContain('background-color');
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

// The editor is rebuilt whenever one of its dependencies changes — a locale
// switch changes the placeholder baked into the extensions, and reopening a
// node changes the fragment. Rebuilding destroys the old instance, and a
// DESTROYED editor is not null: its `schema` is. So a guard that only asks
// `if (!editor) return` lets every effect run against a corpse, and the first
// one to touch the schema throws.
describe('PromptEditor — effects after the editor is rebuilt', () => {
  it('does not touch the destroyed instance when the placeholder changes', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('hello')]);
    fragment.insert(0, [paragraph]);

    /** Render at a given placeholder; changing it rebuilds the editor. */
    const view = (placeholder: string): React.JSX.Element => (
      <PromptEditor
        fragment={fragment}
        placeholder={placeholder}
        onTextChange={vi.fn()}
        onAtMentionsChange={vi.fn()}
        references={[]}
        imageRefsDisabled
        mentionEmptyLabel='none'
        mentionNoMatchLabel='No matches'
      />
    );

    const { rerender } = render(view('Describe the image'));
    await waitFor(() =>
      expect(
        screen.getByTestId('generate-prompt-editor').querySelector('.ProseMirror'),
      ).not.toBeNull(),
    );

    // A locale switch. The old editor is destroyed here; anything still
    // holding it must notice.
    rerender(view('Décrivez l’image'));

    await waitFor(() =>
      expect(
        screen.getByTestId('generate-prompt-editor').querySelector('.ProseMirror'),
      ).not.toBeNull(),
    );
  });
});

describe('PromptEditor — `@` 弹层的两句空态真的到达屏幕（#1952）', () => {
  const EMPTY = 'NOTHING-TO-OFFER';
  const NO_MATCH = 'NOTHING-MATCHED';

  const picture = (name: string): ReferenceRailItem => ({
    refId: `${name}->me`,
    sourceNodeId: name,
    sourceNodeType: 'image',
    sourceNodeName: name,
    thumbnail: `${name}.png`,
  });

  /**
   * 挂一个编辑器，打 `@` 加上给定的字，等弹层提交完。
   *
   * 落点必须在这个文件而不是 `reference-mention.test.tsx`：那边的 `makeEditor()`
   * 造的是没有 `EditorContent` 宿主的裸编辑器，而 `ReactRenderer.render()` 最后
   * 一句是 `editor?.contentComponent?.setRenderer(...)`，`contentComponent` 为
   * null 时那棵 React 子树永远不提交，弹层里什么都没有。这里渲染的是真组件，
   * `PromptEditor.tsx` 里有 `<EditorContent editor={editor} />`。
   * @param opts - 池子、这一档吃不吃参考、`@` 后面打的字。
   * @returns 什么都不返回，断言直接查屏幕。
   */
  async function typeMention(opts: {
    references: ReferenceRailItem[];
    imageRefsDisabled: boolean;
    query?: string;
  }): Promise<void> {
    const doc = new Y.Doc();
    render(
      <PromptEditor
        fragment={doc.getXmlFragment('prompt')}
        placeholder='Describe'
        onTextChange={vi.fn()}
        onAtMentionsChange={vi.fn()}
        references={opts.references}
        imageRefsDisabled={opts.imageRefsDisabled}
        mentionEmptyLabel={EMPTY}
        mentionNoMatchLabel={NO_MATCH}
      />,
    );
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).not.toBeNull(),
    );
    const { editor } = document.querySelector('.ProseMirror') as unknown as {
      editor: { commands: { insertContent: (s: string) => void } };
    };
    act(() => {
      editor.commands.insertContent(`@${opts.query ?? ''}`);
    });
    // 弹层的子树经 portal 提交，同一 tick 里还没 commit —— 不等这一拍，查出来恒为 0。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
  }

  it('池子空：屏幕上看得见「这一档没有可引用的内容」那句', async () => {
    await typeMention({ references: [], imageRefsDisabled: false });
    expect(screen.getByText(EMPTY)).toBeVisible();
    expect(screen.queryByText(NO_MATCH)).toBeNull();
  });

  it('池子非空但被模式滤光：说的还是同一句，而且它可见', async () => {
    await typeMention({
      references: [picture('Alpha')],
      imageRefsDisabled: true,
    });
    expect(screen.getByText(EMPTY)).toBeVisible();
    expect(screen.queryByText(NO_MATCH)).toBeNull();
  });

  it('这一档有货、只是打的字没匹配上：说的是另一句，而且它可见', async () => {
    await typeMention({
      references: [picture('Alpha')],
      imageRefsDisabled: false,
      query: 'zzz',
    });
    expect(screen.getByText(NO_MATCH)).toBeVisible();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it('有匹配时两句都不出场', async () => {
    await typeMention({
      references: [picture('Alpha')],
      imageRefsDisabled: false,
      query: 'alp',
    });
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByText(NO_MATCH)).toBeNull();
  });
});
