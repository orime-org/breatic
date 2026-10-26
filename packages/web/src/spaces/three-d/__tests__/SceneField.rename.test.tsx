// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SceneObjectValuesSchema, t, type SceneObject } from '@breatic/shared';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import { SceneInspector } from '@web/spaces/three-d/SceneInspector';
import { SceneField } from '@web/spaces/three-d/SceneField';

const ID = '11111111-1111-4111-8111-111111111111';
const owners: Array<{ doc: Y.Doc; session: SceneSession }> = [];

/**
 * Subscribe the real inspector to its real document owner.
 * @param root0 - The document-scoped session under test.
 * @param root0.session - The shared command and selection owner.
 * @returns The persistent properties field and a keyboard blur target.
 * @throws {never} Never directly.
 */
function BoundInspector({ session }: { session: SceneSession }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <div data-testid='scene-right-panel' tabIndex={-1}>
    <SceneInspector spaceId='scene' session={session} snapshot={snapshot} namedPeers={[]} Field={SceneField}
      readObjects={() => readSceneDocument(session.doc).objects} />
    <input autoComplete='off' aria-label='Next field' />
  </div>;
}

/**
 * Seed an editable scene without replacing any rename or collaboration code.
 * @returns The real scene document, session, field and user interaction driver.
 * @throws {never} Never directly.
 */
function setup(): { doc: Y.Doc; session: SceneSession; input: HTMLElement; user: ReturnType<typeof userEvent.setup> } {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', 1);
  const object: SceneObject = {
    id: ID, name: 'Figure', model: { kind: 'builtin', id: 'figure' },
    position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false, exists: true,
  };
  applySceneCommand(doc, { type: 'create', objects: [object] }, Symbol('fixture'), true);
  const session = new SceneSession(doc);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  session.select(ID, false);
  owners.push({ doc, session });
  render(<BoundInspector session={session} />);
  return { doc, session, input: screen.getByLabelText(t('spaces.threeD.name')), user: userEvent.setup() };
}

// jsdom clears its focused element before dispatching blur, unlike the browser.
beforeEach(() => { vi.spyOn(document, 'hasFocus').mockReturnValue(true); });
afterEach(() => {
  cleanup();
  for (const { doc, session } of owners.splice(0)) {
    session.destroy();
    doc.destroy();
  }
  vi.restoreAllMocks();
});

describe('scene name editing follows the Canvas rename contract (inner#1705)', () => {
  it.each(['Enter', 'blur'] as const)('commits one trimmed nonblank name on %s', async (exit) => {
    const { doc, session, input, user } = setup();
    await user.click(input);
    fireEvent.change(input, { target: { value: '  New figure  ' } });
    if (exit === 'Enter') await user.keyboard('{Enter}');
    else await user.click(screen.getByLabelText('Next field'));
    expect(readSceneDocument(doc).objects[0]?.name).toBe('New figure');
    expect(input).toHaveValue('New figure');
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    act(() => session.historyStep('undo'));
    expect(readSceneDocument(doc).objects[0]?.name).toBe('Figure');
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it.each(['Enter', 'blur'] as const)('discards a blank name on %s without creating an invalid draft or history entry', async (exit) => {
    const { doc, session, input, user } = setup();
    await user.click(input);
    fireEvent.change(input, { target: { value: '   ' } });
    if (exit === 'Enter') await user.keyboard('{Enter}');
    else await user.click(screen.getByLabelText('Next field'));
    expect(readSceneDocument(doc).objects[0]?.name).toBe('Figure');
    expect(input).toHaveValue('Figure');
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    expect(session.getSnapshot().canUndo).toBe(false);
    expect(session.getSnapshot().commandError).toBeNull();
  });

  it('cancels the name draft on Escape and does not submit it again on blur', async () => {
    const { doc, session, input, user } = setup();
    await user.click(input);
    fireEvent.change(input, { target: { value: 'Cancelled name' } });
    await user.keyboard('{Escape}');
    await user.click(screen.getByLabelText('Next field'));
    expect(input).toHaveValue('Figure');
    expect(readSceneDocument(doc).objects[0]?.name).toBe('Figure');
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it.each([
    { key: 'Enter', isComposing: true, keyCode: 13 },
    { key: 'Escape', isComposing: true, keyCode: 27 },
    { key: 'Enter', isComposing: false, keyCode: 229 },
    { key: 'Escape', isComposing: false, keyCode: 229 },
  ])('preserves the name draft for input-method $key (composing=$isComposing, code=$keyCode)', async (event) => {
    const { doc, session, input, user } = setup();
    await user.click(input);
    fireEvent.change(input, { target: { value: 'Composition draft' } });
    fireEvent.keyDown(input, event);
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Composition draft');
    expect(readSceneDocument(doc).objects[0]?.name).toBe('Figure');
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it.each(['Enter', 'Escape'] as const)('preserves the name draft for %s immediately after compositionend', async (key) => {
    const { doc, session, input, user } = setup();
    await user.click(input);
    fireEvent.change(input, { target: { value: 'Composition draft' } });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key, keyCode: key === 'Enter' ? 13 : 27 });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Composition draft');
    expect(readSceneDocument(doc).objects[0]?.name).toBe('Figure');
    expect(session.getSnapshot().canUndo).toBe(false);
    await user.keyboard('{Enter}');
    expect(readSceneDocument(doc).objects[0]?.name).toBe('Composition draft');
  });

  it.each(['Enter', 'Escape'] as const)('does not end a name edit on repeated %s', async (key) => {
    const { doc, session, input, user } = setup();
    await user.click(input);
    fireEvent.change(input, { target: { value: 'Held-key draft' } });
    fireEvent.keyDown(input, { key, repeat: true });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Held-key draft');
    expect(readSceneDocument(doc).objects[0]?.name).toBe('Figure');
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('uses the existing scene name limit without inheriting the shorter Canvas node limit', async () => {
    const { doc, input, user } = setup();
    expect(input).toHaveAttribute('maxlength', String(SceneObjectValuesSchema.shape.name.maxLength));
    const name = 'Long scene object name '.repeat(4).trim();
    expect(SceneObjectValuesSchema.shape.name.parse(name)).toBe(name);
    await user.click(input);
    fireEvent.change(input, { target: { value: name } });
    await user.keyboard('{Enter}');
    expect(readSceneDocument(doc).objects[0]?.name).toBe(name);
    expect(input).toHaveValue(name);
  });

  it('keeps the focused draft and personal undo preserves the latest peer name and transform', async () => {
    const { doc, session, input, user } = setup();
    await user.click(input);
    act(() => {
      applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, name: 'Peer title', position: [0, 7, 0] }] }, Symbol('peer'), true);
    });
    expect(input).toHaveValue('Figure');
    await user.click(screen.getByLabelText('Next field'));
    expect(readSceneDocument(doc).objects[0]).toMatchObject({ name: 'Figure', position: [0, 7, 0] });
    act(() => session.historyStep('undo'));
    expect(readSceneDocument(doc).objects[0]).toMatchObject({ name: 'Peer title', position: [0, 7, 0] });
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
  });
});
