// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 8 (inner#1790 web spec 24.2, Y2): the size
 * filter watches its binding's document for whose Yjs transaction is
 * running (`beforeObserverCalls`); the listener is added when the editor's
 * view is built and removed when it is destroyed, so mounting and unmounting
 * editors on one Space document does not pile listeners up.
 */

import { Editor, Extension } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { documentBodyFragment } from '@breatic/shared';
import { getDoc } from '@web/data/yjs/manager';
import { makeBang, peerNode } from '@web/features/collab-editor/__tests__/helpers/h7-editors';
import {
  CANVAS_NAME, CHIP_A, DOCUMENT_NAME, capture, enterState, fragmentOf, resetHarness, tiptapExtensions,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';
import { ySyncPluginKey as tiptapSyncKey } from '@web/features/collab-editor/collab-plugin-keys';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { writeProposalPrompt } from '@web/spaces/canvas/generate/proposal-prompt';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

/** Counts a document's `on` minus `off` calls for one event, passing both through. */
interface ListenerCount {
  /** Listeners added minus listeners removed so far. */
  net: () => number;
  restore: () => void;
}

/**
 * Starts counting a document's listeners of one event.
 * @param doc - The Space document.
 * @param event - The event name.
 * @returns The count.
 * @throws {never} Never.
 */
function countListeners(doc: Y.Doc, event: string): ListenerCount {
  const on = vi.spyOn(doc, 'on');
  const off = vi.spyOn(doc, 'off');
  return {
    net: () => on.mock.calls.filter(([name]) => name === event).length - off.mock.calls.filter(([name]) => name === event).length,
    restore: () => {
      on.mockRestore();
      off.mockRestore();
    },
  };
}

/** Mounts one editor of a kind on the document and returns its unmount. */
type Mount = () => () => void;

/**
 * A document body editor on the registered document Space.
 * @param doc - The document.
 * @returns The mount.
 * @throws {never} Never.
 */
function bodyMount(doc: Y.Doc): Mount {
  return () => {
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
    editor.mount(document.createElement('div'));
    return () => { editor.unmount(); };
  };
}

/**
 * A canvas prompt editor (its collaboration half from `buildCollabExtensions`) on node-1's prompt.
 * @param doc - The canvas document.
 * @returns The mount.
 * @throws {never} Never.
 */
function promptMount(doc: Y.Doc): Mount {
  return () => {
    const editor = new Editor({ element: document.createElement('div'), extensions: tiptapExtensions('prompt', fragmentOf(doc, 'prompt')) });
    return () => { editor.destroy(); };
  };
}

beforeEach(() => {
  changeLocale('en');
});

afterEach(() => {
  resetHarness();
});

describe('24.2 the filter\'s document listener goes with its editor', () => {
  it.each([
    ['document body', 1],
    ['document body', 50],
    ['document body', 200],
    ['canvas prompt', 1],
    ['canvas prompt', 50],
    ['canvas prompt', 200],
  ] as const)('W8-06 %s mounted and unmounted %i times: no beforeObserverCalls listener is left; one mounted editor holds a fixed number', (kind, times) => {
    let doc: Y.Doc;
    let mount: Mount;
    if (kind === 'document body') {
      doc = getDoc(DOCUMENT_NAME);
      mount = bodyMount(doc);
    } else {
      doc = getDoc(CANVAS_NAME);
      peerNode(doc);
      mount = promptMount(doc);
    }
    enterState(kind === 'document body' ? DOCUMENT_NAME : CANVAS_NAME, 'N');
    const count = countListeners(doc, 'beforeObserverCalls');
    let unmount = mount();
    const held = count.net();
    unmount();
    expect(count.net()).toBe(0);
    for (let k = 1; k < times; k += 1) mount()();
    expect(count.net()).toBe(0);
    unmount = mount();
    expect(count.net()).toBe(held);
    unmount();
    expect(count.net()).toBe(0);
    count.restore();
  });

  it('W8-07 after a prompt editor that carried an appending plugin is destroyed, writeProposalPrompt writes only its own update', () => {
    const doc = getDoc(CANVAS_NAME);
    peerNode(doc);
    enterState(CANVAS_NAME, 'N');
    const bang = makeBang(tiptapSyncKey);
    const carried = Extension.create({ name: 'appendsBangAfterRedraw', addProseMirrorPlugins: () => [bang.plugin] });
    const fragment = fragmentOf(doc, 'prompt');
    const editor = new Editor({ element: document.createElement('div'), extensions: [...tiptapExtensions('prompt', fragment), carried] });
    editor.view.destroy();
    bang.arm();
    const cap = capture(doc);
    expect(() => {
      writeProposalPrompt(fragment, [{ text: 'a cat on' }, { ref: 0 }], () => ({ sourceNodeId: CHIP_A.sourceNodeId, label: CHIP_A.sourceNodeName, kind: 'image' }));
    }).not.toThrow();
    expect(cap.updates).toHaveLength(1);
    expect(fragment.toString()).not.toContain('!');
    editor.destroy();
  });
});
