// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { projectBodyTree } from '@web/spaces/document/document-body-codec';
import {
  assertModelBody, cloneModelDoc, closeModelBodies, copyModel, expectedModelDoc,
  modelFixture, moveModelUnits, openModelBody, seedModelOwner, typeModelUnit,
  type ModelBody, type ModelOwner, type ModelTrace,
} from '@web/spaces/document/__tests__/document-body-model-helpers';

describe('compiler boundaries after independent C and R placement', () => {
  for (const text of ['AABA', 'A😀BA']) {
    for (const route of ['swap-first-two', 'swap-halves', 'cross-owner', 'suffix-then-last'] as const) {
      for (const insertion of [0, 2, 4]) {
        it(`refines ${route} boundaries for ${JSON.stringify(text)} before fresh input at ${insertion}`, () => {
          const trace: ModelTrace = { authors: [], actions: [], deliveries: [], frames: [] };
          const doc = modelFixture([{ id: 'A', text }, { id: 'B', text: 'AA' }, { id: 'E', text: '' }]);
          const body = openModelBody(doc, trace);
          const bodies: ModelBody[] = [body];
          const model = [seedModelOwner(doc, 'A', text), seedModelOwner(doc, 'B', 'AA'), seedModelOwner(doc, 'E', '')];
          const snapshots: ModelOwner[][] = [copyModel(model)];
          const registrations: unknown[] = [];
          let userUpdates = 0;
          /** Observes genuine REG projections independently from the accepted PM transaction. @throws {Error} If a real registration becomes incomplete. */
          function observe(_update: Uint8Array, origin: unknown): void {
            if (origin === body.origin) userUpdates += 1;
            else {
              const read = projectBodyTree(doc, body.editor.pmSchema, { document: 'document:production-model', epoch: 1 });
              if (read.status !== 'ready') throw new Error('A complete REG became pending');
              registrations.push(read.projection.doc.toJSON());
            }
          }
          doc.on('update', observe);
          try {
            assertModelBody(body, model);
            const moves = route === 'cross-owner'
              ? [[0, 1, 1, 3, 1], [1, 0, 1, 3, 1]] as const
              : route === 'suffix-then-last'
                ? [[0, 0, 2, 4, 0], [0, 0, 3, 4, 0]] as const
                : route === 'swap-halves'
                  ? [[0, 0, 2, 4, 0], [0, 0, 2, 4, 0]] as const
                  : [[0, 0, 1, 2, 0], [0, 0, 1, 2, 0]] as const;
            for (const [sourceIndex, targetIndex, start, end, at] of moves) {
              const before = expectedModelDoc(body.editor.pmSchema, model).toJSON();
              const source = model[sourceIndex];
              const target = model[targetIndex];
              body.history.stopCapturing();
              registrations.splice(0);
              const updatesBefore = userUpdates;
              moveModelUnits(body, source, start, end, target, at);
              const moved = source.units.splice(start, end - start);
              target.units.splice(source === target && at > end ? at - moved.length : at, 0, ...moved);
              assertModelBody(body, model);
              expect(registrations).toEqual([before]);
              expect(userUpdates).toBe(updatesBefore + 1);
              snapshots.push(copyModel(model));
              expect(body.history.undoStack).toHaveLength(snapshots.length - 1);
            }
            const expectedText = route === 'suffix-then-last' ? [...Array.from(text).slice(1), Array.from(text)[0]].join('') : text;
            expect(model.map((owner) => owner.units.map((unit) => unit.value).join(''))).toEqual([expectedText, 'AA', '']);
            body.history.stopCapturing();
            registrations.splice(0);
            const beforeInput = expectedModelDoc(body.editor.pmSchema, model).toJSON();
            const updatesBefore = userUpdates;
            const unit = typeModelUnit(body, model[0], insertion, 'Z', 'fresh:deterministic-boundary');
            model[0].units.splice(insertion, 0, unit);
            assertModelBody(body, model);
            expect(registrations).toEqual([beforeInput]);
            expect(userUpdates).toBe(updatesBefore + 1);
            snapshots.push(copyModel(model));
            expect(body.history.undoStack).toHaveLength(3);
            doc.off('update', observe);
            for (let index = snapshots.length - 2; index >= 0; index -= 1) {
              act(() => { body.history.undo(); });
              assertModelBody(body, snapshots[index]);
              expect(body.history.undoStack).toHaveLength(index);
            }
            for (let index = 1; index < snapshots.length; index += 1) {
              act(() => { body.history.redo(); });
              assertModelBody(body, snapshots[index]);
              expect(body.history.undoStack).toHaveLength(index);
            }
            const reopened = openModelBody(cloneModelDoc(doc), trace);
            bodies.push(reopened);
            assertModelBody(reopened, model, [body.doc, reopened.doc]);
          } finally {
            doc.off('update', observe);
            closeModelBodies(bodies);
          }
        });
      }
    }
  }
});
