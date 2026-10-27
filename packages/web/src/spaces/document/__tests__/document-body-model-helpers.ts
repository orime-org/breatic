// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { expect } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import type { BodyRecord, BodyTreeView } from '@breatic/shared';
import { documentBodyFragment, documentBodyRecords, documentBodySource, readBodyTree, registerDocumentBodyRecords } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { BodyOriginMirror } from '@web/spaces/document/document-body-provenance';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';
import type { CodecOwner } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

/** Independent scalar payload and its original native UTF-16 labels. */
export interface ModelUnit {
  readonly label: string;
  readonly value: string;
  readonly tokens: readonly string[];
  bold: boolean;
}

/** Test-owned ordered owner; production projection is never used to fill this state. */
export interface ModelOwner {
  readonly id: string;
  quoted: boolean;
  units: ModelUnit[];
  children?: ModelOwner[];
}

/** A real emitted local frame, retained separately from its delivery schedule. */
export interface ModelFrame {
  readonly author: number;
  readonly sequence: number;
  readonly hash: string;
  readonly bytes: Uint8Array;
}

/** Replay evidence attached to a fast-check counterexample after shrinking. */
export interface ModelTrace {
  authors: number[];
  actions: unknown[];
  deliveries: unknown[];
  frames: { author: number; sequence: number; hash: string }[];
  observations?: unknown[];
}

/** Actual editor, native history and finite resource lifetime. */
export interface ModelBody {
  readonly doc: Y.Doc;
  readonly editor: ReturnType<typeof buildDocumentEditor>;
  readonly runtime: DocumentBodyRuntime;
  readonly history: Y.UndoManager;
  readonly origin: object;
  readonly host: HTMLElement;
  readonly frames: ModelFrame[];
  readonly trace: ModelTrace;
  readonly releaseFrames: () => void;
}

/** Computes a deterministic non-cryptographic fingerprint of the actual update bytes. @throws {never} */
function frameHash(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `${bytes.length}:${(hash >>> 0).toString(16)}`;
}

/** Reuses the codec fixture format with deterministic native identities before the first registration. @throws {Error} If the independently described records are invalid. */
export function modelFixture(owners: readonly CodecOwner[]): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1619000000;
  const records: BodyRecord[] = [
    { id: 'root', kind: 'root', attrs: {} },
    { id: 'group', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'root', order: 'a' },
  ];
  for (const [index, owner] of owners.entries()) {
    records.push({ id: owner.id, kind: 'owner', type: owner.type ?? 'paragraph', attrs: owner.attrs ?? {}, wrapperAttrs: { id: owner.id }, parent: owner.parent ?? 'group', order: String.fromCharCode(65 + index), facet: `F:${owner.id}`, base: owner.base ?? true });
    records.push({ id: `F:${owner.id}`, kind: 'facet', owner: owner.id, parent: owner.id, order: 'z' });
  }
  registerDocumentBodyRecords(doc, {
    records,
    sources: owners.map((owner) => ({ id: `S:${owner.id}`, facet: `F:${owner.id}`, head: `head:${owner.id}`, tail: `tail:${owner.id}` })),
    contexts: [{ id: 'base', dependencies: [] }],
  });
  const { metadata } = documentBodyRecords(doc);
  metadata.set('format', 'breatic.document.records');
  metadata.set('version', 1);
  metadata.set('seedRoot', 'root');
  for (const owner of owners) if (owner.text !== '') documentBodySource(doc, `S:${owner.id}`).insert(1, owner.text, { ctx: 'base' });
  return doc;
}

/** Mounts the production factory with an origin-scoped native manager. @throws {Error} If the actual factory fails. */
export function openModelBody(doc: Y.Doc, trace: ModelTrace): ModelBody {
  // Client IDs affect native concurrent insertion order and must replay with seed/path.
  doc.clientID = 1619000001 + trace.authors.length;
  const origin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), body: { document: 'document:production-model', origin, runtime, history } });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const frames: ModelFrame[] = [];
  /** Retains each real local update including registration and native history. @throws {never} */
  function capture(bytes: Uint8Array, actualOrigin: unknown): void {
    if (actualOrigin === 'model-network') return;
    const frame = { author: doc.clientID, sequence: frames.length, hash: frameHash(bytes), bytes: bytes.slice() };
    frames.push(frame);
    trace.frames.push({ author: frame.author, sequence: frame.sequence, hash: frame.hash });
  }
  doc.on('update', capture);
  act(() => editor.mount(host));
  trace.authors.push(doc.clientID);
  return { doc, editor, runtime, history, origin, host, frames, trace, releaseFrames: () => doc.off('update', capture) };
}

/** Releases actual resources for every generated example and every shrink. @throws {Error} If the editor cannot unmount. */
export function closeModelBodies(bodies: readonly ModelBody[]): void {
  act(() => {
    for (const body of [...bodies].reverse()) {
      body.releaseFrames();
      body.editor.unmount();
      body.runtime.dispose();
      body.history.destroy();
      body.host.remove();
      body.doc.destroy();
    }
  });
}

/** Clones the real seed before any author makes a local edit. @throws {Error} If Yjs rejects the seed. */
export function cloneModelDoc(doc: Y.Doc): Y.Doc {
  const peer = new Y.Doc({ gc: false });
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc), 'model-network');
  return peer;
}

/** Reads physical source labels independently of any tree, codec or journal projection. @throws {Error} If a native source item is missing. */
export function rawModelTokens(doc: Y.Doc): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const source of documentBodyRecords(doc).sources.keys()) {
    const text = documentBodySource(doc, source);
    let offset = 0;
    for (const run of text.toDelta()) {
      if (typeof run.insert === 'string') {
        for (const value of run.insert.split('')) {
          const item = Y.createRelativePositionFromTypeIndex(text, offset).item;
          if (item === null) throw new Error('Missing physical native item');
          tokens.set(`${source}/${item.client}:${item.clock}`, value);
          offset += 1;
        }
      } else offset += 1;
    }
  }
  return tokens;
}

/** Captures seed identities from known source text rather than reading the tested projection. @throws {Error} If the seed does not have its promised payload. */
export function seedModelOwner(doc: Y.Doc, id: string, value: string): ModelOwner {
  const source = documentBodySource(doc, `S:${id}`);
  let offset = 1;
  const units = Array.from(value, (scalar, ordinal): ModelUnit => {
    const tokens = scalar.split('').map(() => {
      const item = Y.createRelativePositionFromTypeIndex(source, offset++).item;
      if (item === null) throw new Error('Missing seed label');
      return `S:${id}/${item.client}:${item.clock}`;
    });
    return { label: `${id}:${ordinal}`, value: scalar, tokens, bold: false };
  });
  return { id, quoted: false, units };
}

/** Copies independent oracle snapshots, including per-scalar mark payloads. @throws {never} */
export function copyModel(owners: readonly ModelOwner[]): ModelOwner[] {
  return structuredClone(owners) as ModelOwner[];
}

/** Measures UTF-16 offsets from the test-owned scalar array. @throws {never} */
export function modelOffset(units: readonly ModelUnit[], at: number): number {
  return units.slice(0, at).reduce((offset, unit) => offset + unit.value.length, 0);
}

/** Reads an actual owner target only to drive input; it never supplies an expected value. @throws {Error} If the requested independent target is absent. */
export function modelTarget(body: ModelBody, owner: string): { from: number; wrapper: number; content: PMNode } {
  const entry = bodyBindingOf(body.editor.prosemirrorState)?.read().index.owners.get(owner);
  if (entry === undefined) throw new Error(`Missing driver target ${owner}`);
  return { from: entry.contentFrom, wrapper: entry.from, content: body.editor.prosemirrorState.doc.nodeAt(entry.contentFrom - 1)! };
}

/** Inserts a scalar with explicitly empty stored marks and captures only its physical allocation. @throws {Error} If fresh allocation disagrees with the known inserted scalar. */
export function typeModelUnit(body: ModelBody, owner: ModelOwner, at: number, value: string, label: string): ModelUnit {
  const before = rawModelTokens(body.doc);
  const from = modelTarget(body, owner.id).from + modelOffset(owner.units, at);
  const view = body.editor.prosemirrorView;
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from)).setStoredMarks([]).insertText(value)));
  if (body.runtime.read().status !== 'active') recordModelFailure(body);
  const fresh = [...rawModelTokens(body.doc)].filter(([token]) => !before.has(token));
  expect(fresh.map(([, character]) => character).join('')).toBe(value);
  expect(fresh).toHaveLength(value.length);
  return { label, value, tokens: fresh.map(([token]) => token), bold: false };
}

/** Splits through the real production compiler using an explicitly named new owner. @throws {RangeError} If the requested scalar boundary is invalid. */
export function splitModelOwner(body: ModelBody, owner: ModelOwner, at: number, created: string): void {
  const target = modelTarget(body, owner.id);
  const view = body.editor.prosemirrorView;
  const wrapper = view.state.doc.nodeAt(target.wrapper)!;
  act(() => view.dispatch(view.state.tr.split(target.from + modelOffset(owner.units, at), 2, [
    { type: wrapper.type, attrs: { ...wrapper.attrs, id: created } },
    { type: target.content.type, attrs: target.content.attrs },
  ])));
}

/** Joins through the installed Backspace handlers, including the real provenance producer. @throws {Error} If the actual key chain does not accept the join. */
export function joinModelOwner(body: ModelBody, right: ModelOwner): void {
  const from = modelTarget(body, right.id).from;
  const view = body.editor.prosemirrorView;
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from))));
  let handled = false;
  act(() => { handled = view.someProp('handleKeyDown', (handler) => handler(view, new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))) === true; });
  expect(handled).toBe(true);
}

/** Moves an actual selected scalar range with the existing source-preserving producer. @throws {Error} If the production mirror cannot preserve provenance. */
export function moveModelUnits(body: ModelBody, source: ModelOwner, start: number, end: number, target: ModelOwner, at: number): void {
  const sourceFrom = modelTarget(body, source.id).from;
  const targetFrom = modelTarget(body, target.id).from;
  const view = body.editor.prosemirrorView;
  const frame = bodyBindingOf(view.state)!.read();
  const transaction = view.state.tr;
  const mirror = new BodyOriginMirror(transaction, {
    sourceAt: new Map(frame.units.map((unit) => [unit.pos, unit.token])),
    sourceOrigins: new Map(frame.units.map((unit) => [unit.token, unit.origin])),
  });
  mirror.moveRange(sourceFrom + modelOffset(source.units, start), sourceFrom + modelOffset(source.units, end), targetFrom + modelOffset(target.units, at));
  act(() => view.dispatch(transaction));
}

/** Builds complete expected JSON solely from independent ordered payload arrays and schema defaults. @throws {RangeError} If expected nodes violate the actual installed schema. */
export function expectedModelDoc(schema: Schema, owners: readonly ModelOwner[]): PMNode {
  /** Builds one independent nested owner without consulting an actual projection. @throws {RangeError} If the expected node is invalid. */
  function block(owner: ModelOwner): PMNode {
    return schema.node('blockContainer', { id: owner.id }, [
      schema.node('paragraph', { quoted: owner.quoted }, owner.units.map((unit) => schema.text(unit.value, unit.bold ? [schema.mark('bold')] : []))),
      ...(owner.children === undefined || owner.children.length === 0 ? [] : [schema.node('blockGroup', null, owner.children.map(block))]),
    ]);
  }
  return schema.node('doc', null, schema.node('blockGroup', null, owners.map(block)));
}

/** Follows native undo replacements directly through the Yjs item store, independently of the tree reader. @throws {Error} If a promised label no longer has a native item. */
function currentModelToken(doc: Y.Doc, token: string): string {
  const slash = token.lastIndexOf('/');
  const source = token.slice(0, slash);
  const [client, clock] = token.slice(slash + 1).split(':').map(Number);
  let id = Y.createID(client, clock);
  const seen = new Set<string>();
  for (;;) {
    const key = `${id.client}:${id.clock}`;
    if (seen.has(key) || Y.getState(doc.store, id.client) <= id.clock) throw new Error(`Missing native label ${token}`);
    seen.add(key);
    const item = Y.getItem(doc.store, id);
    if (!(item instanceof Y.Item)) throw new Error(`Non-item native label ${token}`);
    if (item.redone === null) return `${source}/${id.client}:${id.clock}`;
    id = Y.createID(item.redone.client, item.redone.clock + id.clock - item.id.clock);
  }
}

/** Requires a complete native view as an actual observation, never an oracle initializer. @throws {Error} If dependencies remain incomplete. */
export function observedModelTree(body: ModelBody): BodyTreeView {
  const read = readBodyTree(body.doc);
  if (read.status !== 'ready') throw new Error(`Incomplete model source: ${read.status}`);
  return read.view;
}

/** Checks the complete PM tree, native owner order, exact lineage and per-unit payload after every command. @throws {Error} If an independent expected label or actual frame is missing. */
function assertModelState(body: ModelBody, owners: readonly ModelOwner[], lineageDocs: readonly Y.Doc[]): void {
  expect(body.runtime.read().status).toBe('active');
  expect(body.editor.prosemirrorState.doc.toJSON()).toEqual(expectedModelDoc(body.editor.pmSchema, owners).toJSON());
  expect(() => body.editor.prosemirrorState.doc.check()).not.toThrow();
  const view = observedModelTree(body);
  /** Flattens the independent owner tree in its specified preorder. @throws {never} */
  function flatten(rows: readonly ModelOwner[]): ModelOwner[] {
    return rows.flatMap((owner) => [owner, ...flatten(owner.children ?? [])]);
  }
  const expected = flatten(owners);
  expect(view.owners.map((owner) => owner.id)).toEqual(expected.map((owner) => owner.id));
  const allTokens: string[] = [];
  for (const [index, owner] of expected.entries()) {
    const tokens = owner.units.flatMap((unit) => unit.tokens.map((token) => {
      let current = token;
      // Native redone pointers belong to the authoring manager, rather than the wire format.
      for (const doc of lineageDocs) {
        const slash = current.lastIndexOf('/');
        const [client, clock] = current.slice(slash + 1).split(':').map(Number);
        if (Y.getState(doc.store, client) > clock) current = currentModelToken(doc, current);
      }
      return currentModelToken(body.doc, current);
    }));
    allTokens.push(...tokens);
    expect(view.owners[index].units.map((unit) => unit.id)).toEqual(tokens);
    expect(view.owners[index].units.map((unit) => unit.value)).toEqual(owner.units.flatMap((unit) => unit.value.split('')));
    expect(view.owners[index].units.map((unit) => Object.keys(unit.attributes).some((key) => key === 'mark:bold'))).toEqual(owner.units.flatMap((unit) => unit.value.split('').map(() => unit.bold)));
  }
  expect(new Set(allTokens).size).toBe(allTokens.length);
  const frame = bodyBindingOf(body.editor.prosemirrorState)!.read();
  expect(frame.units.map((unit) => unit.token)).toEqual(allTokens);
}

/** Captures actual raw records and source deltas for a failing minimized run only. @throws {never} */
function recordModelFailure(body: ModelBody): void {
  const snapshot = body.runtime.read();
  const failure = snapshot.failure;
  const roots = documentBodyRecords(body.doc);
  const observation = {
    author: body.doc.clientID,
    runtime: { status: snapshot.status, missing: snapshot.missing, failure: failure === null ? null : {
      phase: failure.phase, batch: failure.batch, epoch: failure.epoch,
      error: failure.error instanceof Error ? { name: failure.error.name, message: failure.error.message, stack: failure.error.stack } : failure.error,
      accepted: failure.accepted,
      lastGood: failure.lastGood !== null && typeof failure.lastGood === 'object' && 'doc' in failure.lastGood ? failure.lastGood.doc : null,
    } },
    pm: body.editor.prosemirrorState.doc.toJSON(),
    records: Object.fromEntries(roots.records), facts: Object.fromEntries(roots.facts), enabled: Object.fromEntries(roots.enabled),
    contexts: Object.fromEntries(roots.contexts),
    sources: Object.fromEntries([...roots.sources.keys()].map((source) => [source, documentBodySource(body.doc, source).toDelta()])),
    native: Object.fromEntries(rawModelTokens(body.doc)),
  };
  body.trace.observations = [...body.trace.observations ?? [], observation];
}

/** Checks the complete oracle and saves exact source evidence if any strong assertion fails. @throws {Error} If actual projection or native history differs from the independent model. */
export function assertModelBody(body: ModelBody, owners: readonly ModelOwner[], lineageDocs: readonly Y.Doc[] = [body.doc]): void {
  try {
    assertModelState(body, owners, lineageDocs);
  } catch (error) {
    recordModelFailure(body);
    throw error;
  }
}

/** Delivers one real captured local frame and records its author, fingerprint and repetition. @throws {Error} If native update delivery fails. */
export function deliverModelFrame(frame: ModelFrame, to: ModelBody, trace: ModelTrace, duplicate = false): void {
  trace.deliveries.push({ from: frame.author, to: to.doc.clientID, frame: frame.sequence, hash: frame.hash, duplicate });
  act(() => {
    Y.applyUpdate(to.doc, frame.bytes, 'model-network');
    if (duplicate) Y.applyUpdate(to.doc, frame.bytes, 'model-network');
  });
}

/** Runs shrinkable input and attaches the final minimized replay, IDs and actual frame schedule on failure. @throws {Error} If the generated property fails. */
export function checkBodyModel<T>(arbitrary: fc.Arbitrary<T>, run: (input: T, trace: ModelTrace) => void, seed: number, numRuns = 40): void {
  let lastFailure: ModelTrace | undefined;
  const result = fc.check(fc.property(arbitrary, (input) => {
    const trace: ModelTrace = { authors: [], actions: [], deliveries: [], frames: [] };
    try {
      run(input, trace);
    } catch (error) {
      lastFailure = trace;
      throw error;
    }
  }), { seed, numRuns });
  if (result.failed) {
    throw new Error(JSON.stringify({ seed: result.seed, path: result.counterexamplePath, runs: result.numRuns, shrinks: result.numShrinks, minimized: result.counterexample, trace: lastFailure }), { cause: result.errorInstance });
  }
}
