// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import { applySceneCommand, readSceneDocument } from '../scene-document';

describe('scene duplicate placement feedback', () => {
  it.each([
    ['Figure', 'Figure copy'],
    ['a'.repeat(256), 'a'.repeat(256)],
    ['a'.repeat(251), `${'a'.repeat(251)} copy`],
  ])('names and offsets a duplicated object while respecting the name limit', (name, copiedName) => {
    const doc = new Y.Doc();
    doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
    const source = { id: '11111111-1111-4111-8111-111111111111', name,
      model: { kind: 'builtin' as const, id: 'figure' as const },
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as [number, number, number], locked: false };
    const copyId = '22222222-2222-4222-8222-222222222222';
    const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [source] }, origin, true);
    expect(applySceneCommand(doc, { type: 'duplicate', copies: [{ sourceId: source.id, id: copyId }] }, origin, true))
      .toEqual({ ok: true, ids: [copyId] });
    expect(readSceneDocument(doc).objects.find((object) => object.id === copyId))
      .toEqual({ ...source, id: copyId, name: copiedName, position: [1, 0, 1] });
    expect(readSceneDocument(doc).objects.find((object) => object.id === source.id)).toEqual(source);
    doc.destroy();
  });
});
