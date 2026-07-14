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
import { act, render, waitFor } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
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
