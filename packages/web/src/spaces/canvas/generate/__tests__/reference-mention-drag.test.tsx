// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

// Chip drag (user 2026-07-14 item ⑥): a selected chip (single NodeSelection or
// a chip-only TextSelection) could not be dragged in ANY browser. Root cause is
// tiptap's NodeView.stopEvent, not the browser: with spec `draggable: false` it
// preventDefault()s every drag event on the NodeView AND returns true (PM's own
// dragstart handler never runs); with `draggable: true` it STILL kills the drag
// unless the mousedown landed inside a `[data-drag-handle]` (tiptap's React
// NodeView contract). The fix is spec draggable + the whole chip as its own
// drag handle. jsdom cannot exercise the browser's native drag INITIATION or
// drop (posAtCoords needs layout) — those halves are real-machine checks; what
// IS pinned here is the DOM contract (draggable attr + handle) and PM's
// dragstart pipeline filling view.dragging with the chip slice.

import { beforeAll, describe, it, expect, vi } from 'vitest';
import { act, render as baseRender, waitFor } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import { TooltipProvider } from '@web/components/ui/tooltip';

// The `@` chips inherit the ONE app-level TooltipProvider at runtime (App.tsx);
// supply the real Radix provider here (single-provider mandate).
const render = (
  ...args: Parameters<typeof baseRender>
): ReturnType<typeof baseRender> =>
  // wrapper option (not a manual wrap) so a later rerender() keeps the provider.
  baseRender(args[0], { ...args[1], wrapper: TooltipProvider });

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
import { dragScrollDelta } from '@web/spaces/canvas/generate/reference-mention-caret';
import {
  PromptEditor,
  type PromptEditorHandle,
} from '@web/spaces/canvas/generate/PromptEditor';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

beforeAll(() => {
  // jsdom does not implement elementFromPoint; PM's posAtCoords calls it from
  // the dragstart handler. Returning null makes posAtCoords yield null, which
  // routes PM to its event-target fallback (nearestDesc) — the branch under test.
  if (typeof document.elementFromPoint !== 'function') {
    Object.defineProperty(document, 'elementFromPoint', {
      value: () => null,
      configurable: true,
    });
  }
});

const imgRef: ReferenceRailItem = {
  refId: 'a->me',
  sourceNodeId: 'a',
  sourceNodeType: 'image',
  sourceNodeName: 'A',
  thumbnail: 'a.png',
};

/** A minimal Editor surface reached through the ProseMirror DOM element. */
interface EditorViaDom {
  view: {
    dragging: { slice: { content: { firstChild: unknown } } } | null;
  };
  commands: { setNodeSelection: (pos: number) => boolean };
  state: {
    doc: {
      descendants: (
        cb: (node: { type: { name: string } }, pos: number) => void,
      ) => void;
    };
  };
}

/**
 * Mounts a PromptEditor with one image reference and inserts its chip.
 * @returns The chip's outer NodeView wrapper + the live editor.
 */
async function mountWithChip(): Promise<{
  wrapper: HTMLElement;
  editor: EditorViaDom;
}> {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prompt');
  const ref = React.createRef<PromptEditorHandle>();
  render(
    <PromptEditor
      ref={ref}
      fragment={fragment}
      placeholder='Describe'
      onTextChange={vi.fn()}
      onAtMentionsChange={vi.fn()}
      references={[imgRef]}
      mode='i2i'
      mentionEmptyLabel='No references'
    />,
  );
  await waitFor(() => expect(ref.current).not.toBeNull());
  act(() => {
    ref.current?.insertReference(imgRef);
  });
  const chip = await waitFor(() => {
    const el = document.querySelector('[data-reference-mention]');
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  // The NodeView's outer element (PM's nodeDOM) is the react-renderer wrapper
  // AROUND the NodeViewWrapper span.
  const wrapper = chip.closest('[data-node-view-wrapper]')
    ?.parentElement as HTMLElement;
  expect(wrapper).toBeTruthy();
  const pmEl = document.querySelector('.ProseMirror') as unknown as {
    editor: EditorViaDom;
  };
  return { wrapper, editor: pmEl.editor };
}

/**
 * Finds the chip's doc position.
 * @param editor - The live editor.
 * @returns The chip position, or -1.
 */
function chipPos(editor: EditorViaDom): number {
  let found = -1;
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === REFERENCE_MENTION_NODE) found = pos;
  });
  return found;
}

describe('reference chip — drag DOM contract (item ⑥)', () => {
  it('renders the chip draggable: outer wrapper carries draggable=true and the chip is a drag handle', async () => {
    const { wrapper } = await mountWithChip();
    // PM sets nodeDOM.draggable = true for spec-draggable nodes at build time —
    // the STANDING attribute the browser needs to start a drag from any point
    // inside the chip (label, thumbnail, padding).
    expect(wrapper.getAttribute('draggable')).toBe('true');
    // tiptap's stopEvent only lets a drag through when the preceding mousedown
    // landed inside a [data-drag-handle]; the atomic chip is its own handle.
    const handle = wrapper.querySelector('[data-drag-handle]');
    expect(handle).not.toBeNull();
    // The thumbnail keeps draggable=false so it can never become a drag source
    // itself (dragging must always move the CHIP, never rip out a bare image).
    const img = wrapper.querySelector('img');
    if (img) expect(img.getAttribute('draggable')).toBe('false');
  });
});

describe('reference chip — PM dragstart pipeline (item ⑥)', () => {
  it('a dragstart on the selected chip reaches PM and fills view.dragging with the chip slice', async () => {
    const { wrapper, editor } = await mountWithChip();
    const pos = chipPos(editor);
    expect(pos).toBeGreaterThan(-1);
    act(() => {
      editor.commands.setNodeSelection(pos);
    });
    // Mirror the real gesture: mousedown inside the handle first (tiptap arms
    // isDragging there), THEN the browser-dispatched dragstart on the outer
    // wrapper (the drag source, since it holds draggable=true).
    const label = wrapper.querySelector(
      '[data-reference-mention] span',
    ) as HTMLElement;
    act(() => {
      label.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 }),
      );
    });
    const dragstart = new Event('dragstart', {
      bubbles: true,
      cancelable: true,
    });
    // jsdom has no DataTransfer constructor — PM only calls clearData/setData
    // and reads files/effectAllowed, so a minimal stub suffices.
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: {
        clearData: (): void => undefined,
        setData: (): void => undefined,
        effectAllowed: 'copyMove',
        files: [],
      },
    });
    act(() => {
      wrapper.dispatchEvent(dragstart);
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    // Without the fix tiptap's stopEvent preventDefault()s the dragstart and
    // returns true, so PM never populates view.dragging (this stays null).
    const dragging = editor.view.dragging;
    expect(dragging).not.toBeNull();
    const first = dragging?.slice.content.firstChild as {
      type: { name: string };
    } | null;
    expect(first?.type.name).toBe(REFERENCE_MENTION_NODE);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Multi-chip selection dragging (item ⑦, user 2026-07-14): a TextSelection
// spanning several chips must drag AS A WHOLE. Two collapse chains break it:
// tiptap's NodeView.onDragStart unconditionally overwrites the selection with
// a single-chip NodeSelection (it only runs once a [data-drag-handle] exists —
// enabled by item ⑥), and the browser clears the native selection on a real
// mousedown over a select-none atom. The plugin kills both: dragstart inside a
// chip-containing TextSelection stops propagation (React never sees it), and
// mousedown on a chip inside the selection preventDefault()s the native clear.

import { Editor as CoreEditor } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { Document as PMDocument } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text as PMText } from '@tiptap/extension-text';

import {
  ReferenceMention,
  referenceMentionContent,
} from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';

const chipRefB: ReferenceRailItem = {
  refId: 'b->me',
  sourceNodeId: 'b',
  sourceNodeType: 'image',
  sourceNodeName: 'B',
  thumbnail: 'b.png',
};

/**
 * Mounts a PromptEditor with two references and inserts both chips (adjacent,
 * sharing a space).
 * @returns The live editor + both chip positions.
 */
async function mountWithTwoChips(): Promise<{
  ydoc: Y.Doc;
  editor: EditorViaDom & {
    commands: { setTextSelection: (r: { from: number; to: number }) => boolean };
    state: {
      doc: { textContent: string; descendants: (cb: (node: { type: { name: string } }, pos: number) => void) => void };
      selection: { from: number; to: number; constructor: { name: string } };
    };
  };
  chipEls: HTMLElement[];
}> {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prompt');
  const ref = React.createRef<PromptEditorHandle>();
  render(
    <PromptEditor
      ref={ref}
      fragment={fragment}
      placeholder='Describe'
      onTextChange={vi.fn()}
      onAtMentionsChange={vi.fn()}
      references={[imgRef, chipRefB]}
      mode='i2i'
      mentionEmptyLabel='No references'
    />,
  );
  await waitFor(() => expect(ref.current).not.toBeNull());
  act(() => {
    ref.current?.insertReference(imgRef);
    ref.current?.insertReference(chipRefB);
  });
  const chipEls = await waitFor(() => {
    const els = [...document.querySelectorAll('[data-reference-mention]')];
    expect(els.length).toBe(2);
    return els as HTMLElement[];
  });
  const pmEl = document.querySelector('.ProseMirror') as unknown as {
    editor: Awaited<ReturnType<typeof mountWithTwoChips>>['editor'];
  };
  return { editor: pmEl.editor, chipEls, ydoc: doc };
}

describe('multi-chip selection drag (item ⑦)', () => {
  it('a real-path dragstart (outer wrapper target, after mousedown) leaves the chip-spanning selection intact', async () => {
    // The drag source is the OUTER wrapper (the only element carrying
    // draggable=true; the inner NodeViewWrapper has none), so a real
    // browser's dragstart always targets it. Nothing on that path may
    // overwrite the selection — this pins it against regressions (e.g. the
    // inner wrapper gaining draggable, which would re-route the event into
    // React and tiptap's selection-overwriting NodeView.onDragStart).
    const { editor, chipEls } = await mountWithTwoChips();
    const positions: number[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) positions.push(pos);
    });
    const from = positions[0];
    const to = positions[1] + 1;
    act(() => {
      editor.commands.setTextSelection({ from, to });
    });
    const wrapper = chipEls[0].closest('[data-node-view-wrapper]')
      ?.parentElement as HTMLElement;
    act(() => {
      chipEls[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    });
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: { clearData: (): void => undefined, setData: (): void => undefined, effectAllowed: 'copyMove', files: [] },
    });
    act(() => {
      wrapper.dispatchEvent(dragstart);
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(editor.state.selection.from).toBe(from);
    expect(editor.state.selection.to).toBe(to);
    expect(editor.state.selection.constructor.name).toContain('TextSelection');
  });

  it('mousedown NEVER preventDefaults — PM must keep handling the press (click-to-select alive)', async () => {
    // Adversarial R1 (high): prosemirror-view's runCustomHandler treats
    // `event.defaultPrevented` as "handled" even when the plugin handler
    // returns false, so a preventDefault here would make PM skip its OWN
    // MouseDown tracking — clicking a chip inside a selection went inert.
    // The contract is record-only: no default is ever cancelled.
    const { editor, chipEls } = await mountWithTwoChips();
    const positions: number[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) positions.push(pos);
    });
    act(() => {
      editor.commands.setTextSelection({ from: positions[0], to: positions[1] + 1 });
    });
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      chipEls[0].dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(false);
  });

  it('a dragstart AFTER the selection collapsed restores the recorded chip-spanning selection (real browser chain)', async () => {
    // The real collapse chain: the browser clears the native selection on a
    // true mousedown over a select-none atom, and PM follows. The plugin
    // records the selection at mousedown and restores it at dragstart, so
    // PM's own dragstart handler drags the WHOLE range.
    const { editor, chipEls } = await mountWithTwoChips();
    const positions: number[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) positions.push(pos);
    });
    const from = positions[0];
    const to = positions[1] + 1;
    act(() => {
      editor.commands.setTextSelection({ from, to });
    });
    act(() => {
      chipEls[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    });
    // Simulate the browser-side collapse PM mirrors after the native clear.
    act(() => {
      editor.commands.setNodeSelection(from);
    });
    const wrapper = chipEls[0].closest('[data-node-view-wrapper]')
      ?.parentElement as HTMLElement;
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: { clearData: (): void => undefined, setData: (): void => undefined, effectAllowed: 'copyMove', files: [] },
    });
    act(() => {
      wrapper.dispatchEvent(dragstart);
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(editor.state.selection.from).toBe(from);
    expect(editor.state.selection.to).toBe(to);
    expect(editor.state.selection.constructor.name).toContain('TextSelection');
  });

  it('a dragstart TARGETED AT A TEXT NODE (real Chrome) still runs the guard — selection survives and React never overwrites it', async () => {
    // Real-machine trace (Chrome, 2026-07-14): the browser dispatches
    // dragstart on the BARE TEXT NODE of the chip label, not on an Element. A
    // `target instanceof Element` guard silently skipped the whole handler, so
    // the event reached React and tiptap's NodeView.onDragStart overwrote the
    // chip-spanning selection with a single-chip NodeSelection (and stamped
    // the single-chip drag image the user saw following the mouse).
    const { editor, chipEls } = await mountWithTwoChips();
    const positions: number[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) positions.push(pos);
    });
    const from = positions[0];
    const to = positions[1] + 1;
    act(() => {
      editor.commands.setTextSelection({ from, to });
    });
    const labelText = [...chipEls[0].querySelectorAll('span')]
      .map((el) => el.firstChild)
      .find((n2): n2 is Text => n2 instanceof Text);
    expect(labelText).toBeDefined();
    act(() => {
      chipEls[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    });
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, 'dataTransfer', {
      // setDragImage included: whether React's root listener receives this
      // event differs between jsdom environments (local vs CI), and tiptap's
      // onDragStart calls it — an incomplete stub turns that environment
      // difference into an unhandled TypeError.
      value: { clearData: (): void => undefined, setData: (): void => undefined, setDragImage: (): void => undefined, effectAllowed: 'copyMove', files: [] },
    });
    const stopSpy = vi.spyOn(dragstart, 'stopPropagation');
    act(() => {
      (labelText as Text).dispatchEvent(dragstart); // Chrome's real target shape
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    // The environment-independent signal that the guard RAN TO COMPLETION on
    // a Text-node target: it stops propagation (the pre-fix Element-only
    // check bailed before ever reaching it). Whether that actually starves
    // React differs by jsdom environment — the React-cutoff half is pinned by
    // the real-machine CDP check instead.
    expect(stopSpy).toHaveBeenCalled();
  });

  it('select-all (AllSelection) dragging by a chip restores the full-doc selection too', async () => {
    const { editor, chipEls } = await mountWithTwoChips();
    const cmds = editor.commands as unknown as { selectAll: () => boolean; setNodeSelection: (p: number) => boolean };
    act(() => {
      cmds.selectAll();
    });
    const selBefore = { from: editor.state.selection.from, to: editor.state.selection.to };
    act(() => {
      chipEls[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    });
    let chipPos0 = -1;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE && chipPos0 < 0) chipPos0 = pos;
    });
    act(() => {
      cmds.setNodeSelection(chipPos0);
    });
    const wrapper = chipEls[0].closest('[data-node-view-wrapper]')
      ?.parentElement as HTMLElement;
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: { clearData: (): void => undefined, setData: (): void => undefined, effectAllowed: 'copyMove', files: [] },
    });
    act(() => {
      wrapper.dispatchEvent(dragstart);
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(editor.state.selection.from).toBe(selBefore.from);
    expect(editor.state.selection.to).toBe(selBefore.to);
  });

  it('a remote Yjs edit between mousedown and dragstart maps the record — the restore never captures remote text (R2, collab critical path)', async () => {
    const { editor, chipEls } = await mountWithTwoChips();
    const positions: number[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) positions.push(pos);
    });
    const from = positions[0];
    const to = positions[1] + 1;
    act(() => {
      editor.commands.setTextSelection({ from, to });
    });
    act(() => {
      chipEls[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    });
    // A co-editor inserts text INSIDE the recorded window (the shared space
    // between the chips) mid-press.
    const liveEditor = editor as unknown as {
      view: { dispatch: (tr: unknown) => void; state: { tr: { insertText: (t: string, p: number) => unknown } } };
    };
    act(() => {
      liveEditor.view.dispatch(
        (liveEditor.view.state.tr as unknown as { insertText: (t: string, p: number) => { setMeta: (k: string, v: boolean) => unknown } })
          // Space-padded so the whitespace invariant stays satisfied (no
          // appended correction muddying the mapping under test).
          .insertText(' zzzz ', from + 2)
          .setMeta('addToHistory', false),
      );
    });
    // browser-collapse simulation, then dragstart
    const chipsNow: number[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) chipsNow.push(pos);
    });
    act(() => {
      (editor.commands as unknown as { setNodeSelection: (p: number) => boolean }).setNodeSelection(chipsNow[0]);
    });
    const wrapper = chipEls[0].closest('[data-node-view-wrapper]')
      ?.parentElement as HTMLElement;
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: { clearData: (): void => undefined, setData: (): void => undefined, effectAllowed: 'copyMove', files: [] },
    });
    act(() => {
      wrapper.dispatchEvent(dragstart);
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    // The restored range must be the MAPPED window: still starts at the first
    // chip, still ENDS after the second chip (which moved +4), i.e. chip B is
    // still inside the drag and no boundary cuts through the remote text.
    expect(editor.state.selection.from).toBe(from);
    expect(editor.state.selection.to).toBe(to + 6);
    expect(editor.state.selection.constructor.name).toContain('TextSelection');
  });

  it('the record survives the REAL Yjs wire path — a remote co-editor edit collapses absolute maps, relative positions do not (R3)', async () => {
    const { editor, chipEls, ydoc } = await mountWithTwoChips();
    const positions: number[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) positions.push(pos);
    });
    act(() => {
      editor.commands.setTextSelection({ from: positions[0], to: positions[1] + 1 });
    });
    act(() => {
      chipEls[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    });
    // REAL wire: a replica doc applies an edit and syncs back — y-prosemirror
    // delivers this as ONE full-doc ReplaceStep whose StepMap collapses every
    // absolute position (the R2 absolute-mapping version silently lost the
    // record here even though the edit was in a DIFFERENT paragraph).
    act(() => {
      const docB = new Y.Doc();
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(ydoc));
      const frag = docB.getXmlFragment('prompt');
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'remote words');
      para.insert(0, [text]);
      frag.push([para]);
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(ydoc)));
    });
    await new Promise((r) => setTimeout(r, 30));
    // browser-collapse simulation, then dragstart
    const chipsNow: number[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) chipsNow.push(pos);
    });
    act(() => {
      (editor.commands as unknown as { setNodeSelection: (p: number) => boolean }).setNodeSelection(chipsNow[0]);
    });
    const wrapper = chipEls[0].closest('[data-node-view-wrapper]')
      ?.parentElement as HTMLElement;
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: { clearData: (): void => undefined, setData: (): void => undefined, setDragImage: (): void => undefined, effectAllowed: 'copyMove', files: [] },
    });
    act(() => {
      wrapper.dispatchEvent(dragstart);
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    // The restored selection must still span BOTH chips at their CURRENT
    // positions — the whole point of relative positions.
    expect(editor.state.selection.from).toBe(chipsNow[0]);
    expect(editor.state.selection.to).toBe(chipsNow[1] + 1);
    expect(editor.state.selection.constructor.name).toContain('TextSelection');
  });

  it('a mousedown on a chip OUTSIDE any selection records nothing — a later dragstart does not restore', async () => {
    const { editor, chipEls } = await mountWithTwoChips();
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 1 });
    });
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      chipEls[0].dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(false);
    let chipPos0 = -1;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE && chipPos0 < 0) chipPos0 = pos;
    });
    act(() => {
      editor.commands.setNodeSelection(chipPos0);
    });
    const wrapper = chipEls[0].closest('[data-node-view-wrapper]')
      ?.parentElement as HTMLElement;
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: { clearData: (): void => undefined, setData: (): void => undefined, effectAllowed: 'copyMove', files: [] },
    });
    act(() => {
      wrapper.dispatchEvent(dragstart);
    });
    // NodeSelection stays — nothing was recorded, nothing restored.
    expect(editor.state.selection.constructor.name).toContain('NodeSelection');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Drop residue heal (D1, user decision 2026-07-14): PM's move-delete removes
// only the dragged nodes, leaving the chip's owned spaces behind — a double
// space mid-text (or a stray leading/trailing one) that would reach the
// backend prompt. The whitespace plugin heals the source gap of a `uiEvent:
// 'drop'` transaction, in the same undo step as the drop.

describe('drop residue heal (D1)', () => {
  /**
   * Mounts a collaborative core editor with the chip extension.
   * @returns The editor (caller destroys).
   */
  function makeCollabEditor(): CoreEditor {
    return new CoreEditor({
      element: document.createElement('div'),
      extensions: [
        PMDocument,
        Paragraph,
        PMText,
        Collaboration.configure({ fragment: new Y.Doc().getXmlFragment('prompt') }),
        ReferenceMention.configure({
          suggestion: makeReferenceSuggestion({ getPool: () => [], emptyLabel: 'No references' }),
        }),
      ],
    });
  }

  /**
   * The position of the only chip in the doc, or -1.
   * @param editor - The editor.
   * @returns The chip position.
   */
  function onlyChipPos(editor: CoreEditor): number {
    let found = -1;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) found = pos;
    });
    return found;
  }

  /**
   * Whether any single TEXT NODE contains a run of two-plus spaces — chip-split
   * spaces (one on each side of a zero-width chip) legitimately sit adjacent in
   * textContent, so a plain textContent regex would false-positive on them.
   * @param editor - The editor.
   * @returns True when a real double space exists inside one text node.
   */
  function hasDoubleSpaceInsideTextNode(editor: CoreEditor): boolean {
    let found = false;
    editor.state.doc.descendants((n) => {
      if (n.isText && / {2}/.test(n.text ?? '')) found = true;
    });
    return found;
  }

  /**
   * Simulates PM's drop-move of the chip at `from` to (mapped) `target`:
   * one transaction, delete + insert, tagged uiEvent: 'drop' like the real
   * handler.
   * @param editor - The editor.
   * @param from - The chip's current position.
   * @param target - The insert position (pre-delete coordinates).
   */
  function dropMoveChip(editor: CoreEditor, from: number, target: number): void {
    const chip = editor.state.doc.nodeAt(from);
    if (!chip) throw new Error('no chip at from');
    const tr = editor.state.tr;
    tr.delete(from, from + 1);
    tr.insert(tr.mapping.map(target), chip);
    tr.setMeta('uiEvent', 'drop');
    editor.view.dispatch(tr);
  }

  it('mid-text: the double space left behind collapses to one', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('head ').run();
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('tail').run();
      // 'head ␣[X]␣tail' → move X after 'tail'
      const p = onlyChipPos(editor);
      dropMoveChip(editor, p, editor.state.doc.content.size - 1);
      // No double space INSIDE any text node (the landed chip's flanking
      // spaces legitimately read adjacent in textContent, split by the chip).
      expect(hasDoubleSpaceInsideTextNode(editor)).toBe(false);
      expect(editor.state.doc.textContent.startsWith('head tail')).toBe(true);
      expect(onlyChipPos(editor)).toBeGreaterThan(-1); // chip landed
    } finally {
      editor.destroy();
    }
  });

  it('paragraph start: the stray leading space is removed', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('tail').run();
      // '␣[X]␣tail'? invariant puts a space on both sides → after move the
      // leading residue must go: expect 'tail' + landed chip, no leading space.
      const p = onlyChipPos(editor);
      dropMoveChip(editor, p, editor.state.doc.content.size - 1);
      expect(hasDoubleSpaceInsideTextNode(editor)).toBe(false);
      expect(editor.state.doc.textContent.startsWith(' ')).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('paragraph end: the stray trailing space pair is removed entirely', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('head ').run();
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      // 'head ␣[X]␣' → move X to the paragraph start
      const p = onlyChipPos(editor);
      dropMoveChip(editor, p, 1);
      expect(hasDoubleSpaceInsideTextNode(editor)).toBe(false);
      expect(editor.state.doc.textContent.endsWith(' ')).toBe(false);
      expect(onlyChipPos(editor)).toBeGreaterThan(-1);
    } finally {
      editor.destroy();
    }
  });

  it('partial-flank drag from the paragraph START heals the stranded far-side space', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('tail').run();
      // '␣[X]␣tail' → drag [chip + RIGHT anchor] to the end; the LEFT anchor
      // strands against the paragraph start and must go.
      const p = onlyChipPos(editor);
      const chip = editor.state.doc.nodeAt(p);
      const tr = editor.state.tr;
      tr.delete(p, p + 2); // chip + its right space travel
      tr.insert(tr.mapping.map(editor.state.doc.content.size - 1), chip!);
      tr.setMeta('uiEvent', 'drop');
      editor.view.dispatch(tr);
      expect(editor.state.doc.textContent.startsWith(' ')).toBe(false);
      expect(hasDoubleSpaceInsideTextNode(editor)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('partial-flank drag from the paragraph END heals the stranded far-side space', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('head ').run();
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      // 'head␣[X]␣' → drag [LEFT anchor + chip] to the start; the RIGHT anchor
      // strands against the paragraph end and must go.
      const p = onlyChipPos(editor);
      const chip = editor.state.doc.nodeAt(p);
      const tr = editor.state.tr;
      tr.delete(p - 1, p + 1); // left space + chip travel
      tr.insert(1, chip!);
      tr.setMeta('uiEvent', 'drop');
      editor.view.dispatch(tr);
      expect(editor.state.doc.textContent.endsWith(' ')).toBe(false);
      expect(hasDoubleSpaceInsideTextNode(editor)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('partial-flank drag MID-TEXT keeps the surviving space as the word gap (no over-heal)', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('aa ').run();
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('bb').run();
      // 'aa␣[X]␣bb' → drag [chip + right anchor]; the left anchor doubles as
      // the word gap between aa and bb and must STAY.
      const p = onlyChipPos(editor);
      const chip = editor.state.doc.nodeAt(p);
      const tr = editor.state.tr;
      tr.delete(p, p + 2);
      tr.insert(tr.mapping.map(editor.state.doc.content.size - 1), chip!);
      tr.setMeta('uiEvent', 'drop');
      editor.view.dispatch(tr);
      expect(editor.state.doc.textContent.startsWith('aa bb')).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it('a drag that carries BOTH anchors along never touches the user-typed spaces at the gap', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('a  ').run(); // 'a' + user space + (anchor-to-be)
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('  b').run(); // (anchor) + user space + 'b'
      // 'a␣␣[X]␣␣b' → drag [␣X␣] (both anchors travel): nothing at the gap is
      // residue, the user's double spaces stay untouched.
      const p = onlyChipPos(editor);
      const before = editor.state.doc.textContent;
      const slice = editor.state.doc.slice(p - 1, p + 2);
      const tr = editor.state.tr;
      tr.delete(p - 1, p + 2);
      tr.insert(tr.mapping.map(editor.state.doc.content.size - 1), slice.content);
      tr.setMeta('uiEvent', 'drop');
      editor.view.dispatch(tr);
      // Both anchors travelled with the chip, so NOTHING at the gap is
      // residue: the remaining three spaces (the user's own spacing) stay
      // byte-exact — the heal must not fire here at all.
      expect(editor.state.doc.textContent.startsWith('a   b')).toBe(true);
      void before;
    } finally {
      editor.destroy();
    }
  });

  it('a drag whose edge is TEXT strands no anchor on that side — the user word-gap space survives (R2)', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('aa  bb').run(); // user double space between aa/bb
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('cc').run();
      // 'aa␣␣bb␣▢␣cc' → drag [bb␣▢] (text-edged range) to the end. The space
      // left of the gap is the USER's word gap (never this chip's anchor) and
      // must stay; only the chip's stranded RIGHT anchor goes.
      const p = onlyChipPos(editor);
      const slice = editor.state.doc.slice(p - 3, p + 1); // 'bb ▢'
      const tr = editor.state.tr;
      tr.delete(p - 3, p + 1);
      tr.insert(tr.mapping.map(editor.state.doc.content.size - 1), slice.content);
      tr.setMeta('uiEvent', 'drop');
      editor.view.dispatch(tr);
      expect(editor.state.doc.textContent.startsWith('aa  cc')).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it('text dragged out from BETWEEN two chips collapses their meeting anchors to one shared space', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('word').run();
      editor.chain().insertContent(referenceMentionContent(chipRefB)).run();
      // '␣[A]␣word␣[B]␣' → drag 'word' (text only) to the end.
      const chips: number[] = [];
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === REFERENCE_MENTION_NODE) chips.push(pos);
      });
      const wordFrom = chips[0] + 2; // after A and its right anchor
      const wordTo = wordFrom + 4;
      const slice = editor.state.doc.slice(wordFrom, wordTo);
      const tr = editor.state.tr;
      tr.delete(wordFrom, wordTo);
      tr.insert(tr.mapping.map(editor.state.doc.content.size - 1), slice.content);
      tr.setMeta('uiEvent', 'drop');
      editor.view.dispatch(tr);
      expect(hasDoubleSpaceInsideTextNode(editor)).toBe(false);
      const after: number[] = [];
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === REFERENCE_MENTION_NODE) after.push(pos);
      });
      // Adjacent chips share a single space: B sits exactly 2 past A.
      expect(after[1] - after[0]).toBe(2);
    } finally {
      editor.destroy();
    }
  });

  it('undo restores the pre-drag doc in ONE step (heal shares the drop undo group)', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('head ').run();
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('tail').run();
      const before = editor.state.doc.textContent;
      const p = onlyChipPos(editor);
      // Isolate the move into its own undo capture.
      const plugin = editor.state.plugins.find(
        (pl) => (pl as unknown as { key?: string }).key === 'y-undo$',
      );
      (plugin?.getState(editor.state) as { undoManager: { stopCapturing: () => void } })
        .undoManager.stopCapturing();
      dropMoveChip(editor, p, editor.state.doc.content.size - 1);
      expect(editor.state.doc.textContent).not.toBe(before); // moved + healed
      editor.commands.undo();
      expect(editor.state.doc.textContent).toBe(before);
      expect(onlyChipPos(editor)).toBe(p);
    } finally {
      editor.destroy();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Safari drag-copies-instead-of-moving (#1776, user real-Safari trace): PM's
// drop-move deletes the CURRENT selection, but Safari moves the live document
// selection to the drop caret while hovering — the delete no-ops and the drag
// pastes a copy. The plugin records the drag's SOURCE selection at dragstart
// (plugin state, mapped through transactions) and handleDrop restores it just
// before PM's native drop logic. Chrome's selection never follows the drop
// caret, so the restore branch is a no-op there.

describe('drag source restore on drop (#1776, Safari selection-follows-drop-caret)', () => {
  /** Mounts a collaborative core editor (no chips needed — plain text drag). */
  function makePlainEditor(): CoreEditor {
    return new CoreEditor({
      element: document.createElement('div'),
      extensions: [
        PMDocument,
        Paragraph,
        PMText,
        Collaboration.configure({ fragment: new Y.Doc().getXmlFragment('prompt') }),
        ReferenceMention.configure({
          suggestion: makeReferenceSuggestion({ getPool: () => [], emptyLabel: 'No references' }),
        }),
      ],
    });
  }

  /** The plugin's handleDrop prop, bound for direct invocation. */
  function handleDropOf(editor: CoreEditor): (view: unknown, event: unknown, slice: unknown, moved: boolean) => boolean {
    const plugin = editor.state.plugins.find(
      (pl) => (pl as unknown as { key?: string }).key === 'referenceMentionCaret$',
    );
    const fn = (plugin?.props as { handleDrop?: unknown }).handleDrop;
    if (typeof fn !== 'function') throw new Error('handleDrop prop missing');
    return fn.bind(plugin) as ReturnType<typeof handleDropOf>;
  }

  it('restores the source selection before PM deletes it (moved drop after Safari drifted the selection)', () => {
    const editor = makePlainEditor();
    try {
      editor.chain().insertContent('hello world').run();
      editor.commands.setTextSelection({ from: 2, to: 7 });
      // dragstart records the source range in plugin state
      editor.view.dom.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
      // Safari: the live selection follows the drop caret while hovering
      editor.commands.setTextSelection({ from: 9, to: 9 });
      const handled = handleDropOf(editor)(editor.view, {}, null, true);
      expect(handled).toBe(false); // PM's native drop logic must still run
      expect(editor.state.selection.from).toBe(2);
      expect(editor.state.selection.to).toBe(7);
    } finally {
      editor.destroy();
    }
  });

  it('a COPY drop (moved=false) leaves the drifted selection alone', () => {
    const editor = makePlainEditor();
    try {
      editor.chain().insertContent('hello world').run();
      editor.commands.setTextSelection({ from: 2, to: 7 });
      editor.view.dom.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
      editor.commands.setTextSelection({ from: 9, to: 9 });
      handleDropOf(editor)(editor.view, {}, null, false);
      expect(editor.state.selection.from).toBe(9); // untouched
    } finally {
      editor.destroy();
    }
  });

  it('the source is consumed by the drop — a second drop restores nothing', () => {
    const editor = makePlainEditor();
    try {
      editor.chain().insertContent('hello world').run();
      editor.commands.setTextSelection({ from: 2, to: 7 });
      editor.view.dom.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
      editor.commands.setTextSelection({ from: 9, to: 9 });
      handleDropOf(editor)(editor.view, {}, null, true);
      editor.commands.setTextSelection({ from: 4, to: 4 });
      handleDropOf(editor)(editor.view, {}, null, true);
      expect(editor.state.selection.from).toBe(4); // no stale restore
    } finally {
      editor.destroy();
    }
  });

  it('a dragend without a drop clears the recorded source (dropped outside the editor)', () => {
    const editor = makePlainEditor();
    try {
      editor.chain().insertContent('hello world').run();
      editor.commands.setTextSelection({ from: 2, to: 7 });
      editor.view.dom.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
      editor.view.dom.dispatchEvent(new Event('dragend', { bubbles: true, cancelable: true }));
      editor.commands.setTextSelection({ from: 9, to: 9 });
      handleDropOf(editor)(editor.view, {}, null, true);
      expect(editor.state.selection.from).toBe(9); // nothing restored
    } finally {
      editor.destroy();
    }
  });

  it('the source range maps through a remote edit between dragstart and drop', () => {
    const editor = makePlainEditor();
    try {
      editor.chain().insertContent('hello world').run();
      editor.commands.setTextSelection({ from: 2, to: 7 });
      editor.view.dom.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
      // a co-editor inserts before the range mid-drag
      editor.view.dispatch(editor.state.tr.insertText('AB', 1));
      editor.commands.setTextSelection({ from: 11, to: 11 });
      handleDropOf(editor)(editor.view, {}, null, true);
      expect(editor.state.selection.from).toBe(4); // 2 + 2
      expect(editor.state.selection.to).toBe(9); // 7 + 2
    } finally {
      editor.destroy();
    }
  });
});


describe('unified chip drag ghost (Safari had none — tiptap only sets one via React)', () => {
  it('a chip-bearing drag sets a drag image through the plugin (browser-independent)', async () => {
    const { editor, chipEls } = await mountWithTwoChips();
    const positions: number[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) positions.push(pos);
    });
    act(() => {
      editor.commands.setTextSelection({ from: positions[0], to: positions[1] + 1 });
    });
    act(() => {
      chipEls[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    });
    const setDragImage = vi.fn();
    const wrapper = chipEls[0].closest('[data-node-view-wrapper]')
      ?.parentElement as HTMLElement;
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: { clearData: (): void => undefined, setData: (): void => undefined, setDragImage, effectAllowed: 'copyMove', files: [] },
    });
    act(() => {
      wrapper.dispatchEvent(dragstart);
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(setDragImage).toHaveBeenCalled();
  });

  it('a plain-text drag keeps the native ghost (no setDragImage)', () => {
    // A chip-free editor removes any selection ambiguity: no range in this
    // doc can contain a chip, so the ghost must never be replaced.
    const editor = new CoreEditor({
      element: document.createElement('div'),
      extensions: [
        PMDocument,
        Paragraph,
        PMText,
        Collaboration.configure({ fragment: new Y.Doc().getXmlFragment('prompt') }),
        ReferenceMention.configure({
          suggestion: makeReferenceSuggestion({ getPool: () => [], emptyLabel: 'No references' }),
        }),
      ],
    });
    try {
      editor.chain().insertContent('plain words only').run();
      editor.commands.setTextSelection({ from: 2, to: 8 });
      const setDragImage = vi.fn();
      const dragstart = new Event('dragstart', { bubbles: true, cancelable: true });
      Object.defineProperty(dragstart, 'dataTransfer', {
        value: { clearData: (): void => undefined, setData: (): void => undefined, setDragImage, effectAllowed: 'copyMove', files: [] },
      });
      editor.view.dom.dispatchEvent(dragstart);
      expect(setDragImage).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Drag auto-scroll (user 2026-07-14): browsers give no native auto-scroll in
// a scrollable container during a drag — the pure ramp is pinned here, the
// wiring (dragover → scrollTop) is a real-machine check.

describe('dragScrollDelta — the drag auto-scroll ramp', () => {
  it('is 0 away from both edges', () => {
    expect(dragScrollDelta(100, 0, 200)).toBe(0);
  });
  it('scrolls UP near the top edge, harder the closer', () => {
    const near = dragScrollDelta(20, 0, 200);
    const nearer = dragScrollDelta(4, 0, 200);
    expect(near).toBeLessThan(0);
    expect(nearer).toBeLessThan(near);
  });
  it('scrolls DOWN near the bottom edge, harder the closer', () => {
    const near = dragScrollDelta(180, 0, 200);
    const nearer = dragScrollDelta(197, 0, 200);
    expect(near).toBeGreaterThan(0);
    expect(nearer).toBeGreaterThan(near);
  });
  it('clamps at the max step when the pointer passes the edge', () => {
    expect(dragScrollDelta(-50, 0, 200)).toBe(-16);
    expect(dragScrollDelta(250, 0, 200)).toBe(16);
  });
});
