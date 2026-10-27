// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { cleanupCodecFixtures } from '@web/spaces/document/__tests__/document-body-codec-fixtures';
import {
  assertModelBody, checkBodyModel, closeModelBodies, copyModel, joinModelOwner,
  modelFixture, modelOffset, modelTarget, moveModelUnits, openModelBody, seedModelOwner,
  splitModelOwner, typeModelUnit, type ModelOwner,
} from '@web/spaces/document/__tests__/document-body-model-helpers';

const action = fc.record({
  kind: fc.constantFrom('type', 'delete', 'split', 'join', 'move', 'attrs', 'marks', 'undo', 'redo'),
  owner: fc.nat(30), other: fc.nat(30), from: fc.nat(30), to: fc.nat(30), at: fc.nat(30),
  scalar: fc.constantFrom('A', 'A', 'B', '\u0301', '中', '😀'),
  enabled: fc.boolean(),
});

afterEach(cleanupCodecFixtures);

describe('production body sequential editing array model', () => {
  it('preserves independent labels and payload through continuous editing and native history', () => {
    checkBodyModel(fc.array(action, { minLength: 1, maxLength: 28 }), (commands, trace) => {
      const doc = modelFixture([{ id: 'A', text: 'AABA' }, { id: 'B', text: 'AA' }, { id: 'E', text: '' }]);
      const body = openModelBody(doc, trace);
      let model = [seedModelOwner(doc, 'A', 'AABA'), seedModelOwner(doc, 'B', 'AA'), seedModelOwner(doc, 'E', '')];
      const undo: ModelOwner[][] = [];
      const redo: ModelOwner[][] = [];
      let sequence = 0;
      try {
        assertModelBody(body, model);
        for (const command of commands) {
          trace.actions.push(command);
          body.history.stopCapturing();
          if (command.kind === 'undo' || command.kind === 'redo') {
            const source = command.kind === 'undo' ? undo : redo;
            const target = command.kind === 'undo' ? redo : undo;
            if (source.length > 0) {
              target.push(copyModel(model));
              model = source.pop()!;
              act(() => { if (command.kind === 'undo') body.history.undo(); else body.history.redo(); });
            }
          } else {
            const before = copyModel(model);
            const ownerIndex = command.owner % model.length;
            const owner = model[ownerIndex];
            const at = command.at % (owner.units.length + 1);
            let changed = true;
            if (command.kind === 'type') {
              const unit = typeModelUnit(body, owner, at, command.scalar, `fresh:${sequence++}`);
              owner.units.splice(at, 0, unit);
            } else if (command.kind === 'delete' || command.kind === 'marks') {
              if (owner.units.length === 0) changed = false;
              else {
                const start = command.from % owner.units.length;
                const end = start + 1 + command.to % (owner.units.length - start);
                const from = modelTarget(body, owner.id).from + modelOffset(owner.units, start);
                const to = modelTarget(body, owner.id).from + modelOffset(owner.units, end);
                const view = body.editor.prosemirrorView;
                if (command.kind === 'delete') {
                  act(() => view.dispatch(view.state.tr.delete(from, to)));
                  owner.units.splice(start, end - start);
                } else if (owner.units.slice(start, end).every((unit) => unit.bold === command.enabled)) changed = false;
                else {
                  const transaction = command.enabled
                    ? view.state.tr.addMark(from, to, body.editor.pmSchema.mark('bold'))
                    : view.state.tr.removeMark(from, to, body.editor.pmSchema.marks['bold']);
                  act(() => view.dispatch(transaction));
                  for (const unit of owner.units.slice(start, end)) unit.bold = command.enabled;
                }
              }
            } else if (command.kind === 'split') {
              const id = `generated-owner:${sequence++}`;
              splitModelOwner(body, owner, at, id);
              const right = owner.units.splice(at);
              model.splice(ownerIndex + 1, 0, { id, quoted: owner.quoted, units: right });
            } else if (command.kind === 'join') {
              // A depth-two Backspace joins a paragraph with its immediate previous sibling.
              if (ownerIndex === 0) changed = false;
              else {
                joinModelOwner(body, owner);
                const previous = model[ownerIndex - 1];
                // Installed BlockNote mergeBlocks preserves the current block when its
                // preceding empty paragraph has the same markup (its identity contract).
                if (previous.units.length === 0 && previous.quoted === owner.quoted) model.splice(ownerIndex - 1, 1);
                else {
                  previous.units.push(...owner.units);
                  model.splice(ownerIndex, 1);
                }
              }
            } else if (command.kind === 'attrs') {
              const target = modelTarget(body, owner.id);
              owner.quoted = !owner.quoted;
              const view = body.editor.prosemirrorView;
              act(() => view.dispatch(view.state.tr.setNodeMarkup(target.from - 1, undefined, { ...target.content.attrs, quoted: owner.quoted })));
            } else {
              const target = model[command.other % model.length];
              if (owner.units.length === 0) changed = false;
              else {
                const start = command.from % owner.units.length;
                const end = start + 1 + command.to % (owner.units.length - start);
                const landing = command.at % (target.units.length + 1);
                if (owner === target && landing >= start && landing <= end) changed = false;
                else {
                  moveModelUnits(body, owner, start, end, target, landing);
                  const moved = owner.units.splice(start, end - start);
                  target.units.splice(owner === target && landing > end ? landing - moved.length : landing, 0, ...moved);
                }
              }
            }
            if (changed) {
              undo.push(before);
              redo.length = 0;
            }
          }
          assertModelBody(body, model);
          expect(body.history.undoStack).toHaveLength(undo.length);
          expect(body.history.redoStack).toHaveLength(redo.length);
        }
      } finally {
        closeModelBodies([body]);
      }
    }, 161915201, 70);
  });
});
