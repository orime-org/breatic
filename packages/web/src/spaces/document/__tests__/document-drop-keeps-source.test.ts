// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A move whose drop puts nothing leaves the dragged content where it was, as
 * ProseMirror's own drop gives up when its insertion changes nothing (inner#1351
 * design §5.4.1).
 */

import { act } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';

import { open, positionOf, settled } from './paste-harness';

vi.mock('@web/spaces/document/document-put', async (actual) => ({
  ...(await actual<typeof import('@web/spaces/document/document-put')>()),
  putContent: (): null => null,
}));

it('keeps a moved line where it was when its drop puts nothing', async () => {
  const { editor } = open([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph', content: 'move me' }, { type: 'paragraph', content: 'xxyy' }] as never);
  await act(async () => { await settled(); });
  const view = editor.prosemirrorView;
  const before = view.state.doc.toJSON();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, positionOf(editor, 'move me', 0), positionOf(editor, 'move me', 4))));
  view.focus();
  view.dom.parentElement!.dispatchEvent(new Event('dragstart', { bubbles: true }));
  (view as unknown as { dragging: unknown }).dragging = { slice: view.state.selection.content(), move: true };
  const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
  for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
  const at = positionOf(editor, 'xxyy', 2);
  view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 1, clientY: 1 });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/html'], files: [], items: [], getData: (): string => '<p>x</p>' } });
  view.dom.dispatchEvent(event);
  await settled();
  expect(view.state.doc.toJSON()).toEqual(before);
});
