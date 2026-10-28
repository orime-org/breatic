// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from 'yjs';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';

import {
  documentBodyFragment,
  documentBodyRecords,
  documentBodySource,
  registerDocumentBodyRecords,
  type BodyFact,
  type BodyJsonObject,
  type BodyRecord,
} from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentFallbackExtension } from '@web/spaces/document/document-unsupported-blocknote';

/** Actual editors and native docs whose lifetime is owned by the test. */
const editors: ReturnType<typeof buildDocumentEditor>[] = [];
const docs: Y.Doc[] = [];

/** A test-owned owner descriptor, independent of the codec's output. */
export interface CodecOwner {
  readonly id: string;
  readonly text: string;
  readonly type?: string;
  readonly attrs?: BodyJsonObject;
  readonly parent?: string;
  readonly base?: boolean;
}

/**
 * Assembles exactly the real production schema, including unknown mark support.
 * @returns The real production ProseMirror schema.
 * @throws {Error} If editor assembly fails.
 */
export function codecSchema(): Schema {
  const doc = codecDoc();
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [documentFallbackExtension()] });
  editors.push(editor);
  return editor.pmSchema;
}

/**
 * Allocates one native test document and registers its cleanup.
 * @returns A real native test document.
 * @throws {never}
 */
export function codecDoc(): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  docs.push(doc);
  return doc;
}

/**
 * Releases listeners before destroying the documents that hold their state.
 * @throws {Error} If an editor cannot unmount.
 */
export function cleanupCodecFixtures(): void {
  for (const editor of editors.splice(0)) editor.unmount();
  for (const doc of docs.splice(0)) doc.destroy();
}

/**
 * Registers concrete product records and inserts real native text.
 * @param owners - The independently registered or projected owners.
 * @param containers - Additional independently specified container records.
 * @returns A native document with independently specified base records.
 * @throws {Error} If a fixture violates the shared format.
 */
export function codecFixture(owners: readonly CodecOwner[] = [{ id: 'A', text: 'ABC' }, { id: 'B', text: 'xy' }], containers: readonly BodyRecord[] = []): Y.Doc {
  const doc = codecDoc();
  const records: BodyRecord[] = [
    { id: 'root', kind: 'root', attrs: {} },
    { id: 'group', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'root', order: 'a' },
    ...containers,
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
  const roots = documentBodyRecords(doc);
  roots.metadata.set('format', 'breatic.document.records');
  roots.metadata.set('version', 1);
  roots.metadata.set('seedRoot', 'root');
  for (const owner of owners) {
    if (owner.text !== '') documentBodySource(doc, `S:${owner.id}`).insert(1, owner.text, { ctx: 'base' });
  }
  return doc;
}

/**
 * Registers and enables a test-specified complete fact group.
 * @param doc - The document being inspected.
 * @param group - The immutable fact group identifier.
 * @param facts - The complete facts supplied by this test.
 * @throws {Error} If the test fact is invalid.
 */
export function codecFacts(doc: Y.Doc, group: string, facts: readonly BodyFact[]): void {
  registerDocumentBodyRecords(doc, { facts, groups: [{ id: group, facts: facts.map((fact) => fact.id), history: 'user' }] });
  documentBodyRecords(doc).enabled.set(group, true);
}

/**
 * Reads native client/clock identities directly, without using the projection.
 * @param doc - The document being inspected.
 * @param owner - The stable content owner identifier.
 * @param length - The number of native UTF-16 or embed units.
 * @param start - The initial physical source position.
 * @returns The original native client and clock tokens.
 * @throws {Error} If a requested native unit is absent.
 */
export function codecNativeTokens(doc: Y.Doc, owner: string, length: number, start = 1): string[] {
  const source = `S:${owner}`;
  const text = documentBodySource(doc, source);
  return Array.from({ length }, (_, offset) => {
    const item = Y.createRelativePositionFromTypeIndex(text, start + offset).item;
    if (item === null) throw new Error('Expected a real native source identity');
    return `${source}/${item.client}:${item.clock}`;
  });
}

/**
 * Builds independently expected BlockNote wrapper/content JSON using the real schema.
 * @param schema - The actual installed editor schema.
 * @param id - The stable record or native identity.
 * @param text - The independently expected or inserted text.
 * @param type - The installed content type name.
 * @param attrs - The independently specified content attributes.
 * @returns The independently expected block node.
 * @throws {RangeError} If the expected node is invalid.
 */
export function codecParagraph(schema: Schema, id: string, text: string, type = 'paragraph', attrs: BodyJsonObject = {}): PMNode {
  return schema.node('blockContainer', { id }, schema.node(type, attrs, text === '' ? undefined : schema.text(text)));
}

/**
 * Builds one valid table with independently named cells and block owners.
 * @returns A real native two-cell table fixture.
 * @throws {Error} If format registration fails.
 */
export function codecTableFixture(): Y.Doc {
  return codecFixture([{ id: 'L', text: 'left', parent: 'left' }, { id: 'R', text: 'right', parent: 'right' }], [
    { id: 'table', kind: 'container', type: 'docTable', attrs: { id: 'table' }, parent: 'group', order: 'A' },
    { id: 'row', kind: 'container', type: 'docTableRow', attrs: { id: 'row' }, parent: 'table', order: 'A' },
    { id: 'left', kind: 'container', type: 'docTableCell', attrs: { id: 'left', colspan: 1, rowspan: 1, colwidth: null }, parent: 'row', order: 'A' },
    { id: 'right', kind: 'container', type: 'docTableCell', attrs: { id: 'right', colspan: 1, rowspan: 1, colwidth: null }, parent: 'row', order: 'B' },
  ]);
}
