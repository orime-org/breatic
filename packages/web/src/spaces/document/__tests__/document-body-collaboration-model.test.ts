// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { BodyContext, BodyFact, BodyRecord, BodySource } from '@breatic/shared';
import { documentBodyRecords, documentBodySource, readBodyTree } from '@breatic/shared/document-body';

import { cleanupCodecFixtures } from '@web/spaces/document/__tests__/document-body-codec-fixtures';
import {
  assertModelBody, checkBodyModel, cloneModelDoc, closeModelBodies, copyModel,
  deliverModelFrame, modelFixture, modelOffset, modelTarget, openModelBody, seedModelOwner, splitModelOwner, typeModelUnit,
  type ModelBody, type ModelOwner, type ModelTrace, type ModelUnit,
} from '@web/spaces/document/__tests__/document-body-model-helpers';

const scenario = fc.record({
  authors: fc.integer({ min: 2, max: 3 }),
  word: fc.array(fc.constantFrom('A', 'A', 'B', '😀'), { minLength: 2, maxLength: 7 }),
  cut: fc.nat(30), offset: fc.nat(30), scalar: fc.constantFrom('_', 'A', '😀', '\u0301'),
  ranks: fc.array(fc.nat(30), { minLength: 1, maxLength: 16 }),
  partial: fc.array(fc.record({ author: fc.nat(2), target: fc.nat(2), frame: fc.nat(30), duplicate: fc.boolean() }), { maxLength: 14 }),
  histories: fc.array(fc.record({ author: fc.nat(2), redo: fc.boolean() }), { maxLength: 14 }),
});

afterEach(cleanupCodecFixtures);

/** Delivers a retained local frame while checking pending only preserves a legal last-good projection. @throws {Error} If source updates corrupt the actual editor. */
function deliverPartial(from: ModelBody, to: ModelBody, frameIndex: number, trace: ModelTrace, duplicate: boolean): void {
  const frame = from.frames[frameIndex % from.frames.length];
  const before = to.editor.prosemirrorState.doc.toJSON();
  deliverModelFrame(frame, to, trace, duplicate);
  expect(['active', 'waiting']).toContain(to.runtime.read().status);
  expect(() => to.editor.prosemirrorState.doc.check()).not.toThrow();
  const current = readBodyTree(to.doc);
  if (current.status === 'pending') {
    expect(to.runtime.read().status).toBe('waiting');
    expect(to.editor.prosemirrorState.doc.toJSON()).toEqual(before);
  } else if (current.status === 'ready') {
    const ids = current.view.owners.flatMap((owner) => owner.units.map((unit) => unit.id));
    expect(new Set(ids).size).toBe(ids.length);
  }
}

/** Drains actual local update frames in a shrinkable permutation, always including duplicate deliveries. @throws {Error} If a native update fails. */
function drain(bodies: readonly ModelBody[], ranks: readonly number[], trace: ModelTrace): void {
  const frames = bodies.flatMap((from) => from.frames.map((frame, index) => ({ from, frame, rank: ranks[(index + bodies.indexOf(from)) % ranks.length] })));
  frames.sort((left, right) => left.rank - right.rank || right.frame.sequence - left.frame.sequence);
  for (const { from, frame } of frames) {
    for (const to of [...bodies].reverse()) {
      if (from !== to) deliverPartial(from, to, frame.sequence, trace, true);
    }
  }
}

/** Reads only native embed order; unseen concurrent cut endpoints follow Yjs's own insertion order. @throws {never} */
function physicalCuts(body: ModelBody): string[] {
  return documentBodySource(body.doc, 'S:A').toDelta().flatMap((run: { readonly insert: unknown }) => {
    const value: unknown = run.insert;
    return value !== null && typeof value === 'object' && 'bodyCut' in value && typeof value.bodyCut === 'string' ? [value.bodyCut] : [];
  });
}

/** Validates the two legal trailing slots from native registrations, requiring split support everywhere else. @throws {Error} If the actual placement is outside this independently bounded scenario. */
function seenSplitSupport(body: ModelBody, fresh: ModelUnit, splitFact: string, offset: number, suffixLength: number): boolean {
  const roots = documentBodyRecords(body.doc);
  const facts = new Map([...roots.facts].map(([id, encoded]) => [id, JSON.parse(encoded) as BodyFact]));
  const sourceId = fresh.tokens[0].slice(0, fresh.tokens[0].lastIndexOf('/'));
  const source = JSON.parse(roots.sources.get(sourceId)!) as BodySource;
  const run = documentBodySource(body.doc, sourceId).toDelta().find((entry: { readonly insert: unknown; readonly attributes?: Readonly<Record<string, unknown>> }) => typeof entry.insert === 'string');
  const contextId: unknown = run?.attributes?.['ctx'];
  if (typeof contextId !== 'string') throw new Error('The fresh run has no registered native context');
  const context = JSON.parse(roots.contexts.get(contextId)!) as BodyContext;
  const closure = new Set<string>();
  const queue = [...context.dependencies];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (closure.has(id)) continue;
    const fact = facts.get(id);
    if (fact?.kind !== 'structure') throw new Error(`Invalid structural context dependency ${id}`);
    closure.add(id);
    queue.push(...fact.dependencies);
  }
  const placements = [...closure].flatMap((id) => {
    const fact = facts.get(id)!;
    return fact.kind === 'structure' ? fact.edges.filter((edge) => edge.child === `C:${source.head}`) : [];
  });
  expect(placements).toHaveLength(1);
  const parent = placements[0].parent;
  expect(parent.startsWith('C:')).toBe(true);
  const anchor = parent.slice(2);
  const anchorSources = [...roots.sources.values()].map((encoded) => JSON.parse(encoded) as BodySource).filter((candidate) =>
    documentBodySource(body.doc, candidate.id).toDelta().some((entry: { readonly insert: unknown }) => {
      const value: unknown = entry.insert;
      return value !== null && typeof value === 'object' && 'bodyCut' in value && value.bodyCut === anchor;
    }),
  );
  expect(anchorSources).toHaveLength(1);
  const host = JSON.parse(roots.records.get('H')!) as BodyRecord;
  if (host.kind !== 'owner') throw new Error('Missing registered H owner');
  const independentHostSlot = anchorSources[0].facet === host.facet;
  if (independentHostSlot) {
    // H's own empty source sits after the moved R forest. It is co-located only at H's end.
    expect(offset).toBe(suffixLength);
    expect(closure.has(splitFact)).toBe(false);
  } else {
    expect(anchorSources[0].id).toBe('S:A');
    expect(closure.has(splitFact)).toBe(true);
  }
  if (offset < suffixLength) expect(closure.has(splitFact)).toBe(true);
  body.trace.actions.push({ action: 'validated-seen-slot', source: sourceId, anchor, anchorSource: anchorSources[0].id, context: contextId, dependencies: [...closure], independentHostSlot });
  return !independentHostSlot;
}

describe('production body local-frame collaboration model', () => {
  it.each([false, true])('converges with independent late-input oracle and both histories when peer saw structure=%s', (seen) => {
    checkBodyModel(scenario, (input, trace) => {
      const text = input.word.join('');
      const seed = modelFixture([{ id: 'A', text }, { id: 'Z', text: 'ZZ' }]);
      const peerDocs = Array.from({ length: input.authors - 1 }, () => cloneModelDoc(seed));
      const bodies = [seed, ...peerDocs].map((doc) => openModelBody(doc, trace));
      const [author, peer, third] = bodies;
      const original = seedModelOwner(seed, 'A', text);
      const z = seedModelOwner(seed, 'Z', 'ZZ');
      const cut = 1 + input.cut % (original.units.length - 1);
      const left = { id: 'A', quoted: false, units: original.units.slice(0, cut) };
      const right = { id: 'H', quoted: false, units: original.units.slice(cut) };
      const offset = input.offset % (right.units.length + 1);
      const enabled = [true, true, third !== undefined];
      try {
        const beforeSplitCuts = new Set(physicalCuts(author));
        trace.actions.push({ action: 'split', author: author.doc.clientID, cut, owner: 'H' });
        splitModelOwner(author, original, cut, 'H');
        const splitCut = physicalCuts(author).find((id) => !beforeSplitCuts.has(id));
        if (splitCut === undefined) throw new Error('The native split boundary is absent');
        const splitFact = [...documentBodyRecords(author.doc).facts].find(([, encoded]) => {
          const fact = JSON.parse(encoded) as BodyFact;
          return fact.kind === 'structure' && fact.edges.some((edge) => edge.child === `R:${splitCut}`);
        })?.[0];
        if (splitFact === undefined) throw new Error('The registered split structure is absent');
        assertModelBody(author, [left, right, z]);
        if (seen) {
          for (const frame of author.frames) deliverModelFrame(frame, peer, trace, true);
          assertModelBody(peer, [left, right, z]);
        }
        trace.actions.push({ action: 'late-type', author: peer.doc.clientID, sawStructure: seen, offset, value: input.scalar });
        const beforePeerCuts = new Set(physicalCuts(peer));
        const fresh = typeModelUnit(peer, seen ? right : original, seen ? offset : cut + offset, input.scalar, 'peer:late');
        const peerCut = physicalCuts(peer).find((id) => !beforePeerCuts.has(id)) ?? 'tail:A';
        const peerRetainsSplit = seen && seenSplitSupport(peer, fresh, splitFact, offset, right.units.length);
        const thirdUnit = third === undefined ? null : typeModelUnit(third, z, 1, 'C', 'third:local');
        if (seen && third !== undefined) {
          for (const frame of [...peer.frames].reverse()) deliverPartial(peer, third, frame.sequence, trace, true);
          expect(third.runtime.read().status).toBe('waiting');
        }
        for (const delivery of input.partial) {
          const from = bodies[delivery.author % bodies.length];
          const to = bodies[delivery.target % bodies.length];
          if (from !== to && from.frames.length > 0) deliverPartial(from, to, delivery.frame, trace, delivery.duplicate);
        }
        drain(bodies, input.ranks, trace);
        const cuts = physicalCuts(author);
        const nativeLeftEndpoint = !seen && offset === 0 && cuts.indexOf(peerCut) < cuts.indexOf(splitCut);
        trace.actions.push({ action: 'native-endpoint-order', splitCut, peerCut, cuts, nativeLeftEndpoint });

        /** Computes placement from the observed-structure branch and independent user-intent arrays. @throws {never} */
        function expected(): ModelOwner[] {
          const currentLeft = copyModel([left])[0];
          const currentRight = copyModel([right])[0];
          if (enabled[1]) {
            if (nativeLeftEndpoint) currentLeft.units.push(fresh);
            else currentRight.units.splice(offset, 0, fresh);
          }
          const currentZ = copyModel([z])[0];
          if (enabled[2] && thirdUnit !== null) currentZ.units.splice(1, 0, thirdUnit);
          if (enabled[0] || (peerRetainsSplit && enabled[1])) return [currentLeft, currentRight, currentZ];
          if (seen && enabled[1]) return [copyModel([original])[0], { id: 'H', quoted: false, units: [fresh] }, currentZ];
          return [{ id: 'A', quoted: false, units: [...currentLeft.units, ...currentRight.units] }, currentZ];
        }

        /** Checks independent complete content and the local history of every real author. @throws {Error} If a source dependency remains incomplete. */
        function assertAll(): void {
          const wanted = expected();
          for (const body of bodies) assertModelBody(body, wanted, bodies.map((current) => current.doc));
          for (const [index, body] of bodies.entries()) {
            expect(body.history.undoStack).toHaveLength(enabled[index] ? 1 : 0);
            expect(body.history.redoStack).toHaveLength(enabled[index] ? 0 : 1);
          }
        }

        assertAll();
        // Every sample necessarily visits author undo, peer support release and both native redos.
        const histories = [
          { author: 0, redo: false }, { author: 1, redo: false }, { author: 1, redo: true }, { author: 0, redo: true },
          ...(third === undefined ? [] : [{ author: 2, redo: false }, { author: 2, redo: true }]),
          ...input.histories,
        ];
        for (const command of histories) {
          const index = command.author % bodies.length;
          trace.actions.push({ action: command.redo ? 'redo' : 'undo', author: bodies[index].doc.clientID });
          if (enabled[index] !== command.redo) {
            act(() => { if (command.redo) bodies[index].history.redo(); else bodies[index].history.undo(); });
            enabled[index] = command.redo;
          }
          drain(bodies, input.ranks, trace);
          assertAll();
        }
      } finally {
        closeModelBodies(bodies);
      }
    }, seen ? 161915203 : 161915202, 35);
  });

  it('interleaves independent owner editing sequences from every author with native frame delivery and histories', () => {
    const edit = fc.record({
      author: fc.nat(2), kind: fc.constantFrom('type', 'delete', 'attrs', 'marks', 'undo', 'redo'),
      offset: fc.nat(30), length: fc.nat(30), value: fc.boolean(), scalar: fc.constantFrom('A', '😀', '\u0301'),
    });
    checkBodyModel(fc.record({
      authors: fc.integer({ min: 2, max: 3 }),
      edits: fc.array(edit, { maxLength: 24 }),
      ranks: fc.array(fc.nat(30), { minLength: 1, maxLength: 12 }),
    }), (input, trace) => {
      const seeds = Array.from({ length: input.authors }, (_, index) => ({ id: `author-owner:${index}`, text: index === 0 ? 'AABA' : 'AA' }));
      const seed = modelFixture(seeds);
      const docs = [seed, ...Array.from({ length: input.authors - 1 }, () => cloneModelDoc(seed))];
      const bodies = docs.map((doc) => openModelBody(doc, trace));
      const baseline = seeds.map((owner) => seedModelOwner(seed, owner.id, owner.text));
      const model = copyModel(baseline);
      const undo: ModelOwner[][][] = bodies.map(() => []);
      const redo: ModelOwner[][][] = bodies.map(() => []);
      let sequence = 0;
      try {
        const mandatory = bodies.map((_, author) => ({ author, kind: 'type' as const, offset: 0, length: 0, value: false, scalar: 'A' }));
        for (const item of [...mandatory, ...input.edits]) {
          const index = item.author % bodies.length;
          const body = bodies[index];
          const owner = model[index];
          trace.actions.push({ ...item, actor: body.doc.clientID });
          body.history.stopCapturing();
          if (item.kind === 'undo' || item.kind === 'redo') {
            const source = item.kind === 'undo' ? undo[index] : redo[index];
            const target = item.kind === 'undo' ? redo[index] : undo[index];
            if (source.length > 0) {
              target.push(copyModel([owner]));
              model[index] = source.pop()![0];
              act(() => { if (item.kind === 'undo') body.history.undo(); else body.history.redo(); });
            }
          } else {
            const before = copyModel([owner]);
            let changed = true;
            if (item.kind === 'type') {
              const at = item.offset % (owner.units.length + 1);
              owner.units.splice(at, 0, typeModelUnit(body, owner, at, item.scalar, `author:${index}:fresh:${sequence++}`));
            } else if (item.kind === 'attrs') {
              const target = modelTarget(body, owner.id);
              owner.quoted = !owner.quoted;
              const view = body.editor.prosemirrorView;
              act(() => view.dispatch(view.state.tr.setNodeMarkup(target.from - 1, undefined, { ...target.content.attrs, quoted: owner.quoted })));
            } else if (owner.units.length === 0) changed = false;
            else {
              const start = item.offset % owner.units.length;
              const end = start + 1 + item.length % (owner.units.length - start);
              const from = modelTarget(body, owner.id).from + modelOffset(owner.units, start);
              const to = modelTarget(body, owner.id).from + modelOffset(owner.units, end);
              const view = body.editor.prosemirrorView;
              if (item.kind === 'delete') {
                act(() => view.dispatch(view.state.tr.delete(from, to)));
                owner.units.splice(start, end - start);
              } else if (owner.units.slice(start, end).every((unit) => unit.bold === item.value)) changed = false;
              else {
                act(() => view.dispatch(item.value
                  ? view.state.tr.addMark(from, to, body.editor.pmSchema.mark('bold'))
                  : view.state.tr.removeMark(from, to, body.editor.pmSchema.marks['bold'])));
                for (const unit of owner.units.slice(start, end)) unit.bold = item.value;
              }
            }
            if (changed) {
              undo[index].push(before);
              redo[index].length = 0;
            }
          }
          const local = copyModel(baseline);
          local[index] = model[index];
          assertModelBody(body, local);
          expect(body.history.undoStack).toHaveLength(undo[index].length);
          expect(body.history.redoStack).toHaveLength(redo[index].length);
        }
        drain(bodies, input.ranks, trace);
        for (const body of bodies) assertModelBody(body, model, docs);
        for (const [index, body] of bodies.entries()) {
          if (undo[index].length === 0) continue;
          const current = copyModel([model[index]]);
          model[index] = undo[index].at(-1)![0];
          trace.actions.push({ action: 'final-undo', author: body.doc.clientID });
          act(() => { body.history.undo(); });
          drain(bodies, input.ranks, trace);
          for (const peer of bodies) assertModelBody(peer, model, docs);
          model[index] = current[0];
          trace.actions.push({ action: 'final-redo', author: body.doc.clientID });
          act(() => { body.history.redo(); });
          drain(bodies, input.ranks, trace);
          for (const peer of bodies) assertModelBody(peer, model, docs);
        }
      } finally {
        closeModelBodies(bodies);
      }
    }, 161915207, 35);
  });
});
