// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { z } from "zod";
import type * as Y from "yjs";

import {
  bodyContextSchema, bodyFactSchema, bodyGroupSchema, bodyMetadataSchema,
  bodyRecordSchema, bodySourceSchema, decodeBodyDescription, DocumentBodyFormatError,
  DOCUMENT_BODY_FORMAT, DOCUMENT_BODY_FORMAT_VERSION, encodeBodyDescription, parseBodyDescription,
} from "@shared/document-body-records-schema.js";
import type {
  BodyJsonObject, BodyRecord, BodyRecordRoots,
  BodyRecordsRead, BodyRecordsSnapshot, BodyRegistration, BodySource,
} from "@shared/document-body-records-types.js";

export { DocumentBodyFormatError, DOCUMENT_BODY_FORMAT, DOCUMENT_BODY_FORMAT_VERSION } from "@shared/document-body-records-schema.js";

/** Registration facts carry no local user history. */
export const BODY_REGISTRATION_ORIGIN: unique symbol = Symbol("body-registration");

/** Native inline runs keep structural context separately from semantic marks. */
export const BODY_CONTEXT_ATTRIBUTE = "ctx";

/** Native semantic mark keys retain independent product mark identities. */
export const BODY_MARK_ATTRIBUTE_PREFIX = "mark:";

const META = "body:meta";
const INLINE_PREFIX = "body:inline:";

/**
 * Gets the shared registries through their one stored naming contract.
 * @param doc - The content document.
 * @returns Its native registry roots.
 * @throws {DocumentBodyFormatError} If an existing root has a different native type.
 */
export function documentBodyRecords(doc: Y.Doc): BodyRecordRoots {
  try {
    return {
      metadata: doc.getMap<unknown>(META),
      records: doc.getMap<string>("body:records"),
      sources: doc.getMap<string>("body:sources"),
      facts: doc.getMap<string>("body:facts"),
      groups: doc.getMap<string>("body:groups"),
      enabled: doc.getMap<boolean>("body:enabled"),
      contexts: doc.getMap<string>("body:contexts"),
    };
  } catch (error) {
    throw new DocumentBodyFormatError("Invalid native body registry type", error);
  }
}

/**
 * Gets a permanent text source by its registered identity.
 * @param doc - The content document.
 * @param sourceId - The source's stored identity.
 * @returns Its native text.
 * @throws {DocumentBodyFormatError} If the identity or existing native type is invalid.
 */
export function documentBodySource(doc: Y.Doc, sourceId: string): Y.Text {
  if (sourceId.length === 0) throw new DocumentBodyFormatError("Empty body source identity");
  try {
    return doc.getText(`${INLINE_PREFIX}${sourceId}`);
  } catch (error) {
    throw new DocumentBodyFormatError(`Invalid native source:${sourceId}`, error);
  }
}

/**
 * Reads the physical UTF-16 and embed units of a native source.
 * @param text - A native source.
 * @returns One entry per native source position.
 * @throws {never}
 */
function sourceUnits(text: Y.Text): readonly unknown[] {
  const delta: readonly { readonly insert: unknown }[] = text.toDelta();
  return delta.flatMap((part) => typeof part.insert === "string" ? part.insert.split("") : [part.insert]);
}

/**
 * Recognizes the reserved cut payload in a native source unit.
 * @param value - A native source string unit or embed.
 * @returns The permanent cut identity, or null for an ordinary content unit.
 * @throws {DocumentBodyFormatError} If a reserved cut payload has invalid shape.
 */
export function bodyCutId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("bodyCut" in value)) return null;
  if (typeof value.bodyCut !== "string" || value.bodyCut.length === 0 || Object.keys(value).length !== 1) {
    throw new DocumentBodyFormatError("Invalid body cut payload");
  }
  return value.bodyCut;
}

/**
 * Reads cut positions while checking their reserved wire shape and uniqueness.
 * @param text - A native source.
 * @returns Cut identities and physical positions.
 * @throws {DocumentBodyFormatError} If a cut's payload or identity is invalid.
 */
function sourceCuts(text: Y.Text): ReadonlyMap<string, number> {
  const cuts = new Map<string, number>();
  for (const [index, value] of sourceUnits(text).entries()) {
    const id = bodyCutId(value);
    if (id === null) continue;
    if (cuts.has(id)) throw new DocumentBodyFormatError(`Duplicate cut:${id}`);
    cuts.set(id, index);
  }
  return cuts;
}

/**
 * Checks that explicit records and deterministic cut nodes have distinct identities.
 * @param records - Registered or planned explicit record identities.
 * @param cuts - Registered or planned cut identities.
 * @throws {DocumentBodyFormatError} If an explicit record occupies a derived node identity.
 */
function assertDerivedIdentities(records: Iterable<string>, cuts: Iterable<string>): void {
  const ids = new Set(records);
  for (const cut of cuts) for (const prefix of ["C:", "R:", "P:"]) {
    if (ids.has(`${prefix}${cut}`)) throw new DocumentBodyFormatError(`Conflicting cut-derived node:${prefix}${cut}`);
  }
}

/**
 * Reserves an actual or declared cut identity to one native source.
 * @param owners - The ownership index being assembled.
 * @param cut - The permanent cut identity.
 * @param source - Its registered source identity.
 * @throws {DocumentBodyFormatError} If another source already owns the cut.
 */
function claimCut(owners: Map<string, string>, cut: string, source: string): void {
  const existing = owners.get(cut);
  if (existing !== undefined && existing !== source) throw new DocumentBodyFormatError(`Conflicting cut:${cut}`);
  owners.set(cut, source);
}

/**
 * Validates a physical source endpoint before any native mutation.
 * @param text - The permanent source whose positions include cuts.
 * @param index - A physical UTF-16 or embed boundary.
 * @throws {DocumentBodyFormatError} If the endpoint is outside the source or splits a surrogate pair.
 */
export function assertBodySourceBoundary(text: Y.Text, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > text.length) {
    throw new DocumentBodyFormatError(`Invalid body source boundary:${index}`);
  }
  const units = sourceUnits(text);
  const left = units[index - 1];
  const right = units[index];
  if (typeof left === "string" && typeof right === "string") {
    const before = left.charCodeAt(0);
    const after = right.charCodeAt(0);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      throw new DocumentBodyFormatError(`Half-surrogate body source boundary:${index}`);
    }
  }
}

/**
 * Plans all descriptions of one registry before the first native write.
 * @param map - The destination registry.
 * @param values - The proposed immutable descriptors.
 * @param schema - The registry grammar.
 * @param label - The registry's diagnostic name.
 * @returns Only genuinely new canonical descriptions.
 * @throws {DocumentBodyFormatError} If validation or immutable identity comparison fails.
 */
function planDescriptions<T extends { readonly id: string }>(
  map: Y.Map<string>, values: readonly T[], schema: z.ZodType<T>, label: string,
): ReadonlyMap<string, string> {
  const planned = new Map<string, string>();
  const supplied = new Map<string, string>();
  for (const value of values) {
    const parsed = parseBodyDescription(schema, value, label);
    const encoded = encodeBodyDescription(parsed);
    const prior = supplied.get(parsed.id);
    if (prior !== undefined && prior !== encoded) throw new DocumentBodyFormatError(`Conflicting ${label}:${parsed.id}`);
    supplied.set(parsed.id, encoded);
    const stored = map.get(parsed.id);
    if (stored !== undefined) {
      const existing = decodeBodyDescription(schema, stored, parsed.id, label);
      if (encodeBodyDescription(existing) !== encoded) throw new DocumentBodyFormatError(`Conflicting ${label}:${parsed.id}`);
    } else {
      planned.set(parsed.id, encoded);
    }
  }
  return planned;
}

/**
 * Reads a registry's typed immutable descriptions.
 * @param map - The stored canonical JSON registry.
 * @param schema - Its descriptor grammar.
 * @param label - Its diagnostic name.
 * @returns The typed identity map.
 * @throws {DocumentBodyFormatError} If a stored value violates its grammar or enclosing identity.
 */
function readDescriptions<T extends { readonly id: string }>(
  map: Y.Map<string>, schema: z.ZodType<T>, label: string,
): ReadonlyMap<string, T> {
  return new Map([...map].map(([id, encoded]) => [id, decodeBodyDescription(schema, encoded, id, label)]));
}

/**
 * Registers a complete set of immutable descriptors and empty text sources.
 * @param doc - The content document.
 * @param registration - All descriptions to add in this native registration.
 * @throws {DocumentBodyFormatError} If any proposed description conflicts or has invalid shape.
 * @throws {Error} If native observers fail after the registration has begun.
 */
export function registerDocumentBodyRecords(doc: Y.Doc, registration: BodyRegistration): void {
  const roots = documentBodyRecords(doc);
  const plans = [
    [roots.records, planDescriptions(roots.records, registration.records ?? [], bodyRecordSchema, "record")],
    [roots.sources, planDescriptions(roots.sources, registration.sources ?? [], bodySourceSchema, "source")],
    [roots.facts, planDescriptions(roots.facts, registration.facts ?? [], bodyFactSchema, "fact")],
    [roots.groups, planDescriptions(roots.groups, registration.groups ?? [], bodyGroupSchema, "group")],
    [roots.contexts, planDescriptions(roots.contexts, registration.contexts ?? [], bodyContextSchema, "context")],
  ] as const;
  const sources = readDescriptions(roots.sources, bodySourceSchema, "source");
  const cuts = new Map<string, string>();
  for (const source of sources.values()) {
    const actualCuts = doc.share.has(`${INLINE_PREFIX}${source.id}`)
      ? sourceCuts(documentBodySource(doc, source.id)).keys() : [];
    for (const cut of [source.head, source.tail, ...actualCuts]) claimCut(cuts, cut, source.id);
  }
  const initialize: BodySource[] = [];
  for (const source of registration.sources ?? []) {
    for (const cut of [source.head, source.tail]) {
      claimCut(cuts, cut, source.id);
    }
    if (sources.has(source.id) || initialize.some((planned) => planned.id === source.id)) continue;
    if (!doc.share.has(`${INLINE_PREFIX}${source.id}`)) {
      initialize.push(source);
      continue;
    }
    const text = documentBodySource(doc, source.id);
    if (text.length === 0) initialize.push(source);
    else {
      const existing = sourceCuts(text);
      if (existing.get(source.head) !== 0 || existing.get(source.tail) !== text.length - 1) {
        throw new DocumentBodyFormatError(`Conflicting native source:${source.id}`);
      }
    }
  }
  assertDerivedIdentities([
    ...roots.records.keys(), ...(registration.records ?? []).map((record) => record.id),
  ], cuts.keys());
  doc.transact(() => {
    for (const [map, additions] of plans) for (const [id, encoded] of additions) map.set(id, encoded);
    for (const source of initialize) {
      const text = documentBodySource(doc, source.id);
      text.insertEmbed(0, { bodyCut: source.head }, {});
      text.insertEmbed(1, { bodyCut: source.tail }, {});
    }
  }, BODY_REGISTRATION_ORIGIN);
}

/**
 * Inserts a permanent cut at a validated physical position.
 * @param doc - The content document.
 * @param sourceId - The existing source's identity.
 * @param cutId - The new permanent cut identity.
 * @param index - Its physical UTF-16 or embed position before insertion.
 * @throws {DocumentBodyFormatError} If the cut conflicts, lies outside its source, or splits a scalar.
 * @throws {Error} If native observers fail after the cut insertion.
 */
export function registerBodyCut(doc: Y.Doc, sourceId: string, cutId: string, index: number): void {
  const roots = documentBodyRecords(doc);
  const encoded = roots.sources.get(sourceId);
  if (encoded === undefined) throw new DocumentBodyFormatError(`Missing source:${sourceId}`);
  const source = decodeBodyDescription(bodySourceSchema, encoded, sourceId, "source");
  if (!doc.share.has(`${INLINE_PREFIX}${sourceId}`)) throw new DocumentBodyFormatError(`Missing native source:${sourceId}`);
  const text = documentBodySource(doc, sourceId);
  const cuts = sourceCuts(text);
  if (cutId.length === 0) throw new DocumentBodyFormatError("Empty body cut identity");
  const existing = cuts.get(cutId);
  if (existing !== undefined) {
    if (existing !== index) throw new DocumentBodyFormatError(`Conflicting cut:${cutId}`);
    return;
  }
  if (cuts.get(source.head) !== 0 || cuts.get(source.tail) !== text.length - 1 || index < 1 || index >= text.length) {
    throw new DocumentBodyFormatError(`Invalid body cut boundary:${index}`);
  }
  assertBodySourceBoundary(text, index);
  assertDerivedIdentities(roots.records.keys(), [cutId]);
  for (const [id, value] of roots.sources) {
    const other = decodeBodyDescription(bodySourceSchema, value, id, "source");
    if (id !== sourceId && (other.head === cutId || other.tail === cutId || (
      doc.share.has(`${INLINE_PREFIX}${id}`) && sourceCuts(documentBodySource(doc, id)).has(cutId)
    ))) {
      throw new DocumentBodyFormatError(`Conflicting cut:${cutId}`);
    }
  }
  doc.transact(() => text.insertEmbed(index, { bodyCut: cutId }, {}), BODY_REGISTRATION_ORIGIN);
}

/**
 * Collects dependencies of registered facts, sources and actual native runs.
 * @param doc - The content document.
 * @param body - Parsed immutable descriptions.
 * @returns Missing dependency names in deterministic order.
 * @throws {DocumentBodyFormatError} If existing descriptors have contradictory kinds or ownership.
 */
function missingDependencies(doc: Y.Doc, body: BodyRecordsSnapshot): readonly string[] {
  const missing = new Set<string>();
  const cuts = new Map<string, string>();
  const declaredCuts = new Map<string, string>();
  for (const source of body.sources.values()) {
    for (const cut of [source.head, source.tail]) claimCut(declaredCuts, cut, source.id);
  }
  for (const source of body.sources.values()) {
    const facet = body.records.get(source.facet);
    if (facet === undefined) missing.add(`record:${source.facet}`);
    else if (facet.kind !== "facet") throw new DocumentBodyFormatError(`Invalid source facet:${source.id}`);
    if (!doc.share.has(`${INLINE_PREFIX}${source.id}`)) {
      missing.add(`source:${source.id}`);
      continue;
    }
    const text = documentBodySource(doc, source.id);
    const positions = sourceCuts(text);
    for (const [cut] of positions) {
      claimCut(declaredCuts, cut, source.id);
      claimCut(cuts, cut, source.id);
    }
    for (const boundary of [source.head, source.tail]) if (!positions.has(boundary)) missing.add(`cut:${boundary}`);
    if (positions.has(source.head) && positions.get(source.head) !== 0) throw new DocumentBodyFormatError(`Invalid source head:${source.id}`);
    if (positions.has(source.tail) && positions.get(source.tail) !== text.length - 1) throw new DocumentBodyFormatError(`Invalid source tail:${source.id}`);
    const delta: readonly { readonly attributes?: Readonly<Record<string, unknown>> }[] = text.toDelta();
    for (const run of delta) {
      const context = run.attributes?.[BODY_CONTEXT_ATTRIBUTE];
      if (context !== undefined) {
        if (typeof context !== "string") throw new DocumentBodyFormatError(`Invalid source context:${source.id}`);
        if (!body.contexts.has(context)) missing.add(`context:${context}`);
      }
      for (const [key, value] of Object.entries(run.attributes ?? {})) {
        if (!key.startsWith(BODY_MARK_ATTRIBUTE_PREFIX)) continue;
        if (typeof value !== "object" || value === null || !("factId" in value)) {
          throw new DocumentBodyFormatError(`Invalid source mark:${source.id}`);
        }
        if (typeof value.factId !== "string") throw new DocumentBodyFormatError(`Invalid source mark:${source.id}`);
        const fact = body.facts.get(value.factId);
        if (fact === undefined) missing.add(`fact:${value.factId}`);
        else if (fact.kind !== "mark") throw new DocumentBodyFormatError(`Invalid mark fact:${value.factId}`);
      }
    }
  }
  assertDerivedIdentities(body.records.keys(), cuts.keys());
  /**
   * Checks a stable record or a cut-derived C/R/P node reference.
   * @param id - A referenced tree identity.
   * @throws {never}
   */
  function requireNode(id: string): void {
    if (body.records.has(id)) return;
    if (/^[CRP]:/.test(id)) {
      const cut = id.slice(2);
      if (!cuts.has(cut)) missing.add(`cut:${cut}`);
    } else missing.add(`record:${id}`);
  }
  /**
   * Checks dependencies restricted to complete structure facts.
   * @param ids - Structural identities needed by a live fact or context.
   * @throws {DocumentBodyFormatError} If an existing dependency has a non-structural kind.
   */
  function requireStructures(ids: readonly string[]): void {
    for (const id of ids) {
      const fact = body.facts.get(id);
      if (fact === undefined) missing.add(`fact:${id}`);
      else if (fact.kind !== "structure") throw new DocumentBodyFormatError(`Invalid structural dependency:${id}`);
    }
  }
  const root = body.records.get(body.metadata.seedRoot);
  if (root === undefined) missing.add(`record:${body.metadata.seedRoot}`);
  else if (root.kind !== "root") throw new DocumentBodyFormatError("Invalid body seed root");
  for (const record of body.records.values()) {
    if (record.kind !== "root") requireNode(record.parent);
    if (record.kind === "owner") {
      const facet = body.records.get(record.facet);
      if (facet === undefined) missing.add(`record:${record.facet}`);
      else if (facet.kind !== "facet" || facet.owner !== record.id) throw new DocumentBodyFormatError(`Invalid owner facet:${record.id}`);
    }
    if (record.kind === "facet") {
      const owner = body.records.get(record.owner);
      if (owner === undefined) missing.add(`record:${record.owner}`);
      else if (owner.kind !== "owner" || owner.facet !== record.id) throw new DocumentBodyFormatError(`Invalid facet owner:${record.id}`);
    }
  }
  for (const context of body.contexts.values()) requireStructures(context.dependencies);
  for (const fact of body.facts.values()) {
    requireStructures(fact.dependencies);
    const group = body.groups.get(fact.group);
    if (group === undefined) missing.add(`group:${fact.group}`);
    else if (!group.facts.includes(fact.id)) throw new DocumentBodyFormatError(`Invalid group membership:${fact.id}`);
    if (fact.kind === "structure") for (const edge of fact.edges) {
      requireNode(edge.child);
      requireNode(edge.parent);
    }
    else if (fact.kind !== "mark") requireNode(fact.owner);
  }
  for (const group of body.groups.values()) for (const id of group.facts) {
    const fact = body.facts.get(id);
    if (fact === undefined) missing.add(`fact:${id}`);
    else if (fact.group !== group.id) throw new DocumentBodyFormatError(`Invalid fact group:${id}`);
  }
  for (const id of body.enabled) if (!body.groups.has(id)) missing.add(`group:${id}`);
  return [...missing].sort();
}

/**
 * Decodes the body's own format without changing native shared facts.
 * @param doc - The content document.
 * @returns An absent marker, complete records, or exact missing dependencies.
 * @throws {DocumentBodyFormatError} If the stored grammar, native types or existing references are invalid.
 */
export function readDocumentBodyRecords(doc: Y.Doc): BodyRecordsRead {
  if (!doc.share.has(META)) return { status: "uninitialized" };
  const roots = documentBodyRecords(doc);
  if (roots.metadata.size === 0) return { status: "uninitialized" };
  const metadata = parseBodyDescription(bodyMetadataSchema, roots.metadata.toJSON(), "body metadata");
  const enabled = new Set<string>();
  for (const [id, value] of roots.enabled) {
    if (typeof value !== "boolean") throw new DocumentBodyFormatError(`Invalid enabled group:${id}`);
    if (value) enabled.add(id);
  }
  const body: BodyRecordsSnapshot = {
    metadata,
    records: readDescriptions(roots.records, bodyRecordSchema, "record"),
    sources: readDescriptions(roots.sources, bodySourceSchema, "source"),
    facts: readDescriptions(roots.facts, bodyFactSchema, "fact"),
    groups: readDescriptions(roots.groups, bodyGroupSchema, "group"),
    contexts: readDescriptions(roots.contexts, bodyContextSchema, "context"),
    enabled,
  };
  const missing = missingDependencies(doc, body);
  return missing.length === 0 ? { status: "ready", body } : { status: "pending", missing };
}

/**
 * Registers one stable empty paragraph and publishes its complete format marker.
 * @param doc - The content document being initialized.
 * @param paragraphId - The paragraph identity also held by its preserved XML snapshot.
 * @param attrs - The content type's actual default attributes.
 * @throws {DocumentBodyFormatError} If initialization conflicts with existing immutable data.
 * @throws {Error} If native observers fail during initialization.
 */
export function seedDocumentBodyRecords(doc: Y.Doc, paragraphId: string, attrs: BodyJsonObject): void {
  const root = `${paragraphId}:root`;
  const group = `${paragraphId}:group`;
  const facet = `${paragraphId}:facet`;
  const source = `${paragraphId}:source`;
  const roots = documentBodyRecords(doc);
  const metadata = { format: DOCUMENT_BODY_FORMAT, version: DOCUMENT_BODY_FORMAT_VERSION, seedRoot: root } as const;
  if (roots.metadata.size > 0) {
    const existing = parseBodyDescription(bodyMetadataSchema, roots.metadata.toJSON(), "body metadata");
    if (encodeBodyDescription(existing) !== encodeBodyDescription(metadata)) throw new DocumentBodyFormatError("Conflicting body seed root");
  }
  const records: readonly BodyRecord[] = [
    { id: root, kind: "root", attrs: {} },
    { id: group, kind: "container", type: "blockGroup", attrs: {}, parent: root, order: "a" },
    { id: paragraphId, kind: "owner", type: "paragraph", attrs, wrapperAttrs: { id: paragraphId }, parent: group, order: "a", facet, base: true },
    { id: facet, kind: "facet", owner: paragraphId, parent: paragraphId, order: "a" },
  ];
  doc.transact(() => {
    registerDocumentBodyRecords(doc, { records, sources: [{ id: source, facet, head: `${source}:head`, tail: `${source}:tail` }] });
    for (const [key, value] of Object.entries(metadata)) if (roots.metadata.get(key) !== value) roots.metadata.set(key, value);
  }, BODY_REGISTRATION_ORIGIN);
}
