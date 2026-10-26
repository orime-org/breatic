// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";

import { BODY_CONTEXT_ATTRIBUTE, BODY_MARK_ATTRIBUTE_PREFIX } from "@shared/document-body-records.js";
import { documentBodyFragment } from "@shared/document-body.js";
import { DOCUMENT_SCHEMA } from "@shared/document-schema.js";
import { DocumentBodyFormatError } from "@shared/document-body-records-schema.js";
import type { BodyFact, BodyJsonObject, BodyJsonValue, BodyRecord, BodyRegistration, BodySource } from "@shared/document-body-records-types.js";
import { importIdentity, importJsonObject, importOpaqueChildren, importXmlAttrs, type BodyImportIdentities } from "@shared/document-body-import-xml.js";

/** A complete copied native run, still outside the output document. */
export interface BodyImportRun {
  readonly source: string;
  readonly insert: string | BodyJsonObject;
  readonly attributes: BodyJsonObject;
}

/** Complete validated input to a single base snapshot publication. */
export interface BodyImportPlan {
  readonly root: string;
  readonly registration: BodyRegistration;
  readonly runs: readonly BodyImportRun[];
}

/** Mutable local buffers used only while reading the isolated snapshot. */
interface ImportBuilder {
  readonly identities: BodyImportIdentities;
  readonly root: string;
  readonly group: string;
  readonly context: string;
  readonly records: BodyRecord[];
  readonly sources: BodySource[];
  readonly facts: BodyFact[];
  readonly runs: BodyImportRun[];
}

/**
 * Encodes an ordinal with lexical order identical to its numeric order.
 * @param index - A sibling's original zero-based position.
 * @returns A stable ordered key for the original snapshot.
 * @throws {never}
 */
function importOrder(index: number): string {
  return String(index).padStart(16, "0");
}

/**
 * Copies actual y-prosemirror marks into explicit independent native mark instances.
 * @param builder - Local immutable-description buffers.
 * @param owner - The original repaired owner identity.
 * @param offset - The source offset at the start of this run.
 * @param attrs - Complete original y-prosemirror formatting attributes.
 * @returns Product context and mark references for the copied run.
 * @throws {DocumentBodyFormatError} If a mark payload cannot be represented as JSON attrs.
 */
function importMarks(builder: ImportBuilder, owner: string, offset: number, attrs: BodyJsonObject): BodyJsonObject {
  const entries: [string, BodyJsonValue][] = [[BODY_CONTEXT_ATTRIBUTE, builder.context]];
  for (const [key, value] of Object.entries(attrs)) {
    const resolved = /(.*)(--[a-zA-Z0-9+/=]{8})$/u.exec(key)?.[1] ?? key;
    const type = Object.hasOwn(DOCUMENT_SCHEMA.marks, resolved) ? resolved : key;
    const id = importIdentity(builder.identities, "mark", JSON.stringify([owner, offset, key]));
    builder.facts.push({ id, kind: "mark", group: builder.group, dependencies: [], payload: { type, attrs: importJsonObject(value) } });
    entries.push([`${BODY_MARK_ATTRIBUTE_PREFIX}${key}`, { factId: id }]);
  }
  return Object.fromEntries(entries);
}

/**
 * Copies source text and inline leaves without normalising strings or changing the original XML.
 * @param builder - Local immutable-description and copied-run buffers.
 * @param owner - The content owner's stable identity.
 * @param source - The new permanent source identifier.
 * @param content - The original content element.
 * @throws {DocumentBodyFormatError} If the original inline payload is malformed.
 */
function importInline(builder: ImportBuilder, owner: string, source: string, content: Y.XmlElement): void {
  let offset = 0;
  for (const child of content.toArray()) {
    if (child instanceof Y.XmlText) {
      const delta: readonly { readonly insert?: unknown; readonly attributes?: unknown }[] = child.toDelta();
      for (const run of delta) {
        if (typeof run.insert !== "string") throw new DocumentBodyFormatError("Stored XML text must contain native string runs");
        const attributes = importMarks(builder, owner, offset, importJsonObject(run.attributes ?? {}));
        if (run.insert !== "") builder.runs.push({ source, insert: run.insert, attributes });
        offset += run.insert.length;
      }
    } else if (child instanceof Y.XmlElement) {
      const inline: BodyJsonObject = { type: child.nodeName, attrs: importXmlAttrs(child), ...(child.length === 0 ? {} : { children: importOpaqueChildren(child) }) };
      builder.runs.push({ source, insert: { bodyInline: inline }, attributes: { [BODY_CONTEXT_ATTRIBUTE]: builder.context } });
      offset += 1;
    } else throw new DocumentBodyFormatError("Unsupported stored XML inline type");
  }
}

/**
 * Adds one owner's base record, content facet, source and original inline runs.
 * @param builder - Local buffers for the complete snapshot.
 * @param wrapper - The original block wrapper, including all wrapper attributes.
 * @param content - Its original content node.
 * @param parent - The current group or cell identity.
 * @param order - Original sibling order.
 * @throws {DocumentBodyFormatError} If the repaired original block identity is absent.
 */
function importOwner(builder: ImportBuilder, wrapper: Y.XmlElement, content: Y.XmlElement, parent: string, order: string): void {
  const id: unknown = wrapper.getAttribute("id");
  if (typeof id !== "string" || id === "") throw new DocumentBodyFormatError("Imported block has no stable identity");
  const facet = importIdentity(builder.identities, "facet", id);
  const source = importIdentity(builder.identities, "source", id);
  builder.records.push({ id, kind: "owner", type: content.nodeName, attrs: importXmlAttrs(content), wrapperAttrs: importXmlAttrs(wrapper), parent, order, facet, base: true });
  builder.records.push({ id: facet, kind: "facet", owner: id, parent: id, order: "0" });
  builder.sources.push({ id: source, facet, head: importIdentity(builder.identities, "head", id), tail: importIdentity(builder.identities, "tail", id) });
  importInline(builder, id, source, content);
}

/**
 * Reads one original block or layout container while preserving its actual hierarchy.
 * @param builder - The complete local import buffers.
 * @param block - One original structural XML node.
 * @param parent - The enclosing registered group or layout node.
 * @param order - Its original sibling order.
 * @throws {DocumentBodyFormatError} If the XML structural shape is invalid.
 */
function importBlock(builder: ImportBuilder, block: Y.XmlElement, parent: string, order: string): void {
  if (block.nodeName === "blockGroup") {
    const id = importIdentity(builder.identities, "group", JSON.stringify([parent, order]));
    builder.records.push({ id, kind: "container", type: "blockGroup", attrs: importXmlAttrs(block), parent, order });
    importChildren(builder, block, id);
    return;
  }
  if (["docTable", "docTableRow", "docTableCell", "docTableHeader"].includes(block.nodeName)) {
    const id: unknown = block.getAttribute("id");
    if (typeof id !== "string") throw new DocumentBodyFormatError("Imported layout node has no stable identity");
    builder.records.push({ id, kind: "container", type: block.nodeName, attrs: importXmlAttrs(block), parent, order });
    importChildren(builder, block, id);
    return;
  }
  if (block.nodeName !== "blockContainer") {
    importOwner(builder, block, block, parent, order);
    return;
  }
  const children = block.toArray();
  const content = children[0];
  if (!(content instanceof Y.XmlElement) || content.nodeName === "blockGroup" || children.length > 2 || (children[1] !== undefined && (!(children[1] instanceof Y.XmlElement) || children[1].nodeName !== "blockGroup"))) throw new DocumentBodyFormatError("Malformed stored body block container");
  importOwner(builder, block, content, parent, order);
  if (children[1] instanceof Y.XmlElement) importBlock(builder, children[1], String(block.getAttribute("id")), "1");
}

/**
 * Reads structural children without silently discarding XML text or hooks in block slots.
 * @param builder - Local import buffers.
 * @param element - The original group or layout container.
 * @param parent - Its stable registered identity.
 * @throws {DocumentBodyFormatError} If a structural slot contains a non-element.
 */
function importChildren(builder: ImportBuilder, element: Y.XmlFragment, parent: string): void {
  for (const [index, child] of element.toArray().entries()) {
    if (!(child instanceof Y.XmlElement)) throw new DocumentBodyFormatError("Stored body structural slots require XML elements");
    importBlock(builder, child, parent, importOrder(index));
  }
}

/**
 * Plans a complete base format from a temporary normalized snapshot.
 * @param doc - The isolated XML snapshot with repaired IDs and temporary table normalization.
 * @param identities - Original document ownership and reserved stable identities.
 * @returns All descriptors and native source runs, without writing the output document.
 * @throws {DocumentBodyFormatError} If the current XML root or its payload is malformed.
 */
export function planCurrentDocumentBody(doc: Y.Doc, identities: BodyImportIdentities): BodyImportPlan {
  const root = importIdentity(identities, "root", "content");
  const group = importIdentity(identities, "base-group", root);
  const context = importIdentity(identities, "base-context", root);
  const builder: ImportBuilder = { identities, root, group, context, records: [{ id: root, kind: "root", attrs: {} }], sources: [], facts: [], runs: [] };
  const fragment = documentBodyFragment(doc);
  if (fragment.length === 0) {
    builder.records.push({ id: importIdentity(identities, "empty-group", root), kind: "container", type: "blockGroup", attrs: {}, parent: root, order: importOrder(0) });
  } else {
    if (fragment.length !== 1 || !(fragment.get(0) instanceof Y.XmlElement) || (fragment.get(0) as Y.XmlElement).nodeName !== "blockGroup") throw new DocumentBodyFormatError("Stored document root must contain one block group");
    importChildren(builder, fragment, root);
  }
  return { root, runs: builder.runs, registration: { records: builder.records, sources: builder.sources, facts: builder.facts, contexts: [{ id: context, dependencies: [] }], groups: [{ id: group, history: "base", facts: builder.facts.map((fact) => fact.id) }] } };
}
