// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { BodyFact, BodyRecord } from '@breatic/shared';
import { documentBodyRecords, documentBodySource, registerDocumentBodyRecords } from '@breatic/shared/document-body';

import { cleanupCodecFixtures } from '@web/spaces/document/__tests__/document-body-codec-fixtures';
import {
  assertModelBody, checkBodyModel, cloneModelDoc, closeModelBodies, copyModel,
  deliverModelFrame, modelFixture, openModelBody, seedModelOwner, splitModelOwner,
  type ModelBody, type ModelOwner, type ModelTrace,
} from '@web/spaces/document/__tests__/document-body-model-helpers';

type SupportMode = 'attributes' | 'marks' | 'empty-child';

interface SupportState {
  attributes: { quoted: boolean; dependent: boolean }[];
  marked: boolean;
  alive: boolean;
  hidden: boolean;
  child: boolean;
  parent: 'H' | 'U';
}

interface SupportCommand {
  readonly kind: 'edit' | 'undo' | 'redo' | 'creator-undo' | 'creator-redo';
  readonly value: boolean;
  readonly dependent: boolean;
  readonly remove: boolean;
  readonly host: boolean;
}

const command = fc.record({
  kind: fc.constantFrom('edit', 'undo', 'redo', 'creator-undo', 'creator-redo'),
  value: fc.boolean(), dependent: fc.boolean(), remove: fc.boolean(), host: fc.boolean(),
});

afterEach(cleanupCodecFixtures);

/** Delivers actual retained frames in reverse local order, including duplicates. @throws {Error} If native delivery fails. */
function synchronize(bodies: readonly ModelBody[], trace: ModelTrace): void {
  for (const from of [...bodies].reverse()) {
    for (const frame of [...from.frames].reverse()) {
      for (const to of bodies) if (from !== to) deliverModelFrame(frame, to, trace, true);
    }
  }
}

/** Reads a split operation's registered identities solely to name later observed dependencies. @throws {Error} If the production split emitted no structure unit. */
function splitDependencies(body: ModelBody): string[] {
  const ids = [...documentBodyRecords(body.doc).facts].flatMap(([id, encoded]) => {
    const fact = JSON.parse(encoded) as BodyFact;
    return fact.kind === 'structure' ? [id] : [];
  });
  if (ids.length === 0) throw new Error('The real split did not register a structural unit');
  return ids;
}

/** Registers test-owned empty children and hosts without enabling their births. @throws {Error} If the immutable test records are invalid. */
function registerEmptyChildren(body: ModelBody): void {
  const records: BodyRecord[] = [];
  for (const id of ['U', 'V']) {
    records.push({ id, kind: 'owner', type: 'paragraph', attrs: {}, wrapperAttrs: { id }, parent: 'group', order: id, facet: `F:${id}`, base: false });
    records.push({ id: `F:${id}`, kind: 'facet', owner: id, parent: id, order: 'z' });
  }
  for (const parent of ['H', 'U']) records.push({ id: `children:${parent}`, kind: 'container', type: 'blockGroup', attrs: {}, parent, order: 'z' });
  records.push({ id: 'K', kind: 'owner', type: 'paragraph', attrs: {}, wrapperAttrs: { id: 'K' }, parent: 'children:H', order: 'A', facet: 'F:K', base: false });
  records.push({ id: 'F:K', kind: 'facet', owner: 'K', parent: 'K', order: 'z' });
  registerDocumentBodyRecords(body.doc, {
    records,
    sources: ['U', 'V', 'K'].map((id) => ({ id: `S:${id}`, facet: `F:${id}`, head: `head:${id}`, tail: `tail:${id}` })),
  });
}

/** Locates known C/D payload in the physical source, including inserted cut embeds. @throws {Error} If live source payload is absent. */
function suffixSpan(body: ModelBody): { from: number; length: number } {
  let index = 0;
  let from = -1;
  let end = -1;
  for (const run of documentBodySource(body.doc, 'S:A').toDelta()) {
    if (typeof run.insert === 'string') {
      for (const value of run.insert.split('')) {
        if (value === 'C') from = index;
        if (value === 'D') end = index + 1;
        index += 1;
      }
    } else index += 1;
  }
  if (from < 0 || end <= from) throw new Error('Expected the known live C/D source payload');
  return { from, length: end - from };
}

/** Commits a complete test-owned fact batch through real registration and native origin history. @throws {Error} If immutable registration or native editing fails. */
function commit(body: ModelBody, group: string, facts: readonly BodyFact[], edit: () => void = () => undefined): void {
  registerDocumentBodyRecords(body.doc, { facts, groups: [{ id: group, facts: facts.map((fact) => fact.id), history: 'user' }] });
  act(() => body.doc.transact(() => {
    documentBodyRecords(body.doc).enabled.set(group, true);
    edit();
  }, body.origin));
}

describe('production body support lifetime command model', () => {
  it.each<SupportMode>(['attributes', 'marks', 'empty-child'])('retains and releases only current %s support', (mode) => {
    checkBodyModel(fc.array(command, { maxLength: 18 }), (commands, trace) => {
      const seed = modelFixture([{ id: 'A', text: 'ABCD' }, { id: 'Z', text: 'Z' }]);
      const original = seedModelOwner(seed, 'A', 'ABCD');
      const z = seedModelOwner(seed, 'Z', 'Z');
      const author = openModelBody(seed, trace);
      const bodies = [author];
      let sequence = 0;
      let split = true;
      let state: SupportState = { attributes: [], marked: false, alive: true, hidden: false, child: false, parent: 'H' };
      const undo: SupportState[] = [];
      const redo: SupportState[] = [];
      try {
        splitModelOwner(author, original, 2, 'H');
        const dependencies = splitDependencies(author);
        if (mode === 'empty-child') registerEmptyChildren(author);
        const peer = openModelBody(cloneModelDoc(seed), trace);
        bodies.push(peer);

        /** Computes the specified support outcomes with arrays and a latest-enabled attribute winner. @throws {never} */
        function expected(): ModelOwner[] {
          const winner = state.attributes.at(-1);
          const supported = winner?.dependent === true || (state.alive && state.marked);
          const moved = split || supported;
          const suffix = state.alive ? copyModel([original])[0].units.slice(2) : [];
          if (state.marked) for (const unit of suffix) unit.bold = true;
          const a: ModelOwner = { id: 'A', quoted: false, units: [...original.units.slice(0, 2), ...moved ? [] : suffix] };
          const h: ModelOwner = { id: 'H', quoted: winner?.quoted ?? false, units: moved ? suffix : [] };
          const u: ModelOwner = { id: 'U', quoted: false, units: [] };
          if (state.child) {
            const parent = state.parent === 'H' ? h : u;
            parent.children = [{ id: 'K', quoted: false, units: [] }];
          }
          const hasH = !state.hidden && (split || supported || winner !== undefined || (state.child && state.parent === 'H'));
          return [a, ...hasH ? [h] : [], z, ...state.child && state.parent === 'U' ? [u] : []];
        }

        /** Checks full production projection and local origin history against the independent support reducer. @throws {Error} If a body is incomplete. */
        function verify(): void {
          synchronize(bodies, trace);
          for (const body of bodies) assertModelBody(body, expected(), bodies.map((current) => current.doc));
          expect(author.history.undoStack).toHaveLength(split ? 1 : 0);
          expect(author.history.redoStack).toHaveLength(split ? 0 : 1);
          expect(peer.history.undoStack).toHaveLength(undo.length);
          expect(peer.history.redoStack).toHaveLength(redo.length);
          if (mode === 'empty-child') {
            for (const body of bodies) expect(body.editor.document.some((block: { readonly id: string }) => block.id === 'V')).toBe(false);
          }
        }

        /** Applies one legal generated action without reading expected placement from production. @throws {Error} If a native support operation fails. */
        function apply(input: SupportCommand): void {
          trace.actions.push({ ...input, mode, author: input.kind.startsWith('creator') ? author.doc.clientID : peer.doc.clientID });
          if (input.kind === 'creator-undo' || input.kind === 'creator-redo') {
            const enabled = input.kind === 'creator-redo';
            if (enabled !== split) {
              act(() => { if (enabled) author.history.redo(); else author.history.undo(); });
              split = enabled;
            }
          } else if (input.kind === 'undo' || input.kind === 'redo') {
            const source = input.kind === 'undo' ? undo : redo;
            const target = input.kind === 'undo' ? redo : undo;
            if (source.length > 0) {
              target.push(structuredClone(state));
              state = source.pop()!;
              act(() => { if (input.kind === 'undo') peer.history.undo(); else peer.history.redo(); });
            }
          } else {
            const previous = structuredClone(state);
            const group = `support-model:${sequence++}`;
            const id = `${group}:fact`;
            peer.history.stopCapturing();
            let changed = true;
            if (mode === 'attributes') {
              commit(peer, group, [{ id, kind: 'attribute', group, dependencies: input.dependent ? dependencies : [], owner: 'H', name: 'quoted', value: input.value, counter: sequence }]);
              state.attributes.push({ quoted: input.value, dependent: input.dependent });
            } else if (mode === 'marks') {
              if (!state.alive || (!input.remove && state.marked === input.value)) changed = false;
              else {
                const span = suffixSpan(peer);
                const source = documentBodySource(peer.doc, 'S:A');
                if (input.remove) {
                  const facts: BodyFact[] = input.host ? [{ id, kind: 'delete', group, dependencies: [], owner: 'H' }] : [];
                  commit(peer, group, facts, () => source.delete(span.from, span.length));
                  state.alive = false;
                  state.hidden = input.host;
                } else {
                  commit(peer, group, input.value ? [{ id, kind: 'mark', group, dependencies, payload: { type: 'bold', attrs: {} } }] : [],
                    () => source.format(span.from, span.length, { 'mark:bold': input.value ? { factId: id } : null }));
                  state.marked = input.value;
                }
              }
            } else if (!state.child) {
              commit(peer, group, [{ id, kind: 'birth', group, dependencies: [], owner: 'K' }]);
              state.child = true;
            } else {
              const parent = state.parent === 'H' ? 'U' : 'H';
              commit(peer, group, [{ id, kind: 'structure', group, dependencies: [], edges: [{ child: 'K', parent: `children:${parent}`, counter: sequence, order: 'A' }] }]);
              state.parent = parent;
            }
            if (changed) {
              undo.push(previous);
              redo.length = 0;
            }
          }
          verify();
        }

        const edit: SupportCommand = { kind: 'edit', value: true, dependent: true, remove: false, host: false };
        apply(edit);
        apply({ ...edit, kind: 'creator-undo' });
        apply({ ...edit, kind: 'undo' });
        apply({ ...edit, kind: 'redo' });
        if (mode === 'attributes') {
          apply({ ...edit, value: false, dependent: false });
          apply({ ...edit, kind: 'undo' });
          apply({ ...edit, kind: 'redo' });
        } else if (mode === 'marks') {
          apply({ ...edit, remove: true });
          apply({ ...edit, kind: 'undo' });
          apply({ ...edit, remove: true, host: true });
          apply({ ...edit, kind: 'undo' });
          apply({ ...edit, value: false });
          apply({ ...edit, kind: 'undo' });
        } else {
          apply(edit);
          apply({ ...edit, kind: 'undo' });
          apply({ ...edit, kind: 'redo' });
        }
        for (const input of commands) apply(input);
      } finally {
        closeModelBodies(bodies);
      }
    }, mode === 'attributes' ? 161915204 : mode === 'marks' ? 161915205 : 161915206, 30);
  });
});
