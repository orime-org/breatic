// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  Fragment,
  Schema,
  Slice,
  type ContentMatch,
  type Mark,
  type MarkSpec,
  type Node as PMNode,
  type NodeSpec,
} from '@tiptap/pm/model';
import {
  EditorState,
  NodeSelection,
  Selection,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state';
import { dropPoint, ReplaceAroundStep, ReplaceStep, Step } from '@tiptap/pm/transform';

import { replayBodyJournal } from '@web/spaces/document/document-body-journal';
import {
  BODY_TRACE_MARK,
  assertBodyProvenance,
  bodyOperations,
  recordBodyOperation,
  rebaseBodyOperation,
  type BodyInlineUnit,
  type BodyTransferOperation,
  type BodyHandoff,
  type BodyUnitOrigin,
} from '@web/spaces/document/document-body-provenance-meta';

/** The structural premise checked before private unit tagging can be used. */
export interface BodyMirrorSchemaAudit {
  readonly type: string;
  readonly states: number;
  readonly textTransitions: number;
  readonly content: string;
  readonly marks: string;
}

/** Source names supplied by the current canonical or staged index. */
export interface BodyOriginMirrorOptions {
  readonly sourceAt: ReadonlyMap<number, string>;
  readonly sourceOrigins?: ReadonlyMap<string, BodyUnitOrigin>;
  readonly allocate?: (origin: BodyUnitOrigin) => string;
  readonly ordinal?: number;
}

/** Allocation state shared by commands forked from one live mirror. */
interface MirrorRegistry {
  readonly prefix: string;
  readonly origins: Map<string, BodyUnitOrigin>;
  sequence: number;
  operations: number;
}

/** A private continuation, confined to forked source operations. */
interface MirrorContinuation {
  readonly shadow: Transaction;
  readonly schema: Schema;
  readonly registry: MirrorRegistry;
}

/** A real command runnable against either structurally identical state. */
export type BodyNativeCommand = (state: EditorState, dispatch: (transaction: Transaction) => void) => boolean;

let mirrorSequence = 0;

/**
 * Verifies that splitting text into private units preserves content matching.
 * @param original - The actual product schema.
 * @returns The audited inline grammars and their reachable states.
 * @throws {BodyProvenanceError} If the schema violates the mirror premise.
 */
export function auditBodyMirrorSchema(original: Schema): BodyMirrorSchemaAudit[] {
  assertBodyProvenance(original.marks[BODY_TRACE_MARK] === undefined, 'Private source mark collides with the product schema');
  const text = original.nodes['text'];
  assertBodyProvenance(text !== undefined, 'The product schema has no text node');
  const result: BodyMirrorSchemaAudit[] = [];
  for (const node of Object.values(original.nodes)) {
    assertBodyProvenance(node.spec.attrs?.[BODY_TRACE_MARK] === undefined, 'Private source attribute collides with the product schema');
    assertBodyProvenance(!node.isInline || !node.isAtom || node.isLeaf || node.isText, 'A non-leaf inline atom needs a declared source representation');
    if (!node.inlineContent) continue;
    const seen = new Set<ContentMatch>();
    const pending = [node.contentMatch];
    let transitions = 0;
    while (pending.length > 0) {
      const match = pending.pop()!;
      if (seen.has(match)) continue;
      seen.add(match);
      const next = match.matchType(text);
      if (next !== null) {
        transitions += 1;
        assertBodyProvenance(next.matchType(text) === next, `Unsupported text cardinality in ${node.name}`);
      }
      for (let index = 0; index < match.edgeCount; index += 1) pending.push(match.edge(index).next);
    }
    result.push({ type: node.name, states: seen.size, textTransitions: transitions, content: node.spec.content ?? '', marks: node.spec.marks ?? '<all>' });
  }
  return result;
}

/**
 * Builds the isolated schema while retaining original mark restrictions.
 * @param original - The audited product schema.
 * @returns A structurally equivalent schema with private source tags.
 * @throws {BodyProvenanceError} If unit tagging changes the grammar premise.
 * @throws {RangeError} If ProseMirror rejects a schema specification.
 */
function makeMirrorSchema(original: Schema): Schema {
  auditBodyMirrorSchema(original);
  const nodes: Record<string, NodeSpec> = {};
  const marks: Record<string, MarkSpec> = {};
  original.spec.nodes.forEach((name, spec) => {
    const type = original.nodes[name];
    const copy: NodeSpec = { ...spec };
    if (type.inlineContent && spec.marks !== undefined && spec.marks !== '_') {
      copy.marks = [spec.marks, BODY_TRACE_MARK].filter(Boolean).join(' ');
    }
    if (type.isInline && type.isLeaf && !type.isText) copy.attrs = { ...spec.attrs, [BODY_TRACE_MARK]: { default: null } };
    nodes[name] = copy;
  });
  original.spec.marks.forEach((name, spec) => {
    marks[name] = { ...spec, excludes: spec.excludes === '_' ? Object.keys(original.marks).join(' ') : spec.excludes };
  });
  marks[BODY_TRACE_MARK] = { attrs: { token: {} }, inclusive: false, excludes: '' };
  return new Schema({ nodes, marks, topNode: original.topNodeType.name });
}

/**
 * Narrows JSON objects for structural trace removal.
 * @param value - A value produced by ProseMirror serialization.
 * @returns Whether it has named JSON fields.
 * @throws {never}
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Removes private tags from schema-owned nodes while preserving attribute payloads.
 * @param node - A node from the private schema.
 * @param schema - The actual product schema.
 * @returns The corresponding ordinary node with adjacent text normalized.
 * @throws {RangeError} If the product schema rejects a node or mark.
 */
function stripNode(node: PMNode, schema: Schema): PMNode {
  const marks = node.marks.filter((mark) => mark.type.name !== BODY_TRACE_MARK).map((mark) => schema.mark(mark.type.name, mark.attrs));
  if (node.isText) return schema.text(node.text!, marks);
  const attrs: Record<string, unknown> = { ...node.attrs };
  delete attrs[BODY_TRACE_MARK];
  const children: PMNode[] = [];
  node.forEach((child) => children.push(stripNode(child, schema)));
  return schema.nodes[node.type.name].create(attrs, Fragment.fromArray(children), marks);
}

/**
 * Reads an occurrence's actual block identity from its containing nodes.
 * @param document - The actual stage document.
 * @param position - The inline position.
 * @returns The deepest stable block ID, or null before an ID append.
 * @throws {RangeError} If the position is invalid.
 */
function blockAt(document: PMNode, position: number): string | null {
  const resolved = document.resolve(position);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const id: unknown = resolved.node(depth).attrs['id'];
    if (typeof id === 'string') return id;
  }
  return null;
}

/**
 * Strips sidecar nodes through the original schema's own decoder.
 * @param document - A private mirror document.
 * @param schema - The original product schema.
 * @returns The corresponding ordinary product document.
 * @throws {RangeError} If the product schema rejects the result.
 */
function stripDocument(document: PMNode, schema: Schema): PMNode {
  return stripNode(document, schema);
}

/**
 * Strips only a replacement step's schema-owned slice.
 * @param step - The actual step produced in the private schema.
 * @param schema - The product schema used to decode the ordinary step.
 * @returns The corresponding product step with opaque attributes intact.
 * @throws {BodyProvenanceError} If a replacement step cannot be serialized.
 * @throws {RangeError} If the product schema rejects the step.
 */
function stripStep(step: Step, schema: Schema): Step {
  const raw: unknown = step.toJSON();
  if (!(step instanceof ReplaceStep) && !(step instanceof ReplaceAroundStep)) return Step.fromJSON(schema, raw);
  assertBodyProvenance(isRecord(raw), 'Private replacement step has invalid JSON');
  const children: PMNode[] = [];
  step.slice.content.forEach((node) => children.push(stripNode(node, schema)));
  const slice = new Slice(Fragment.fromArray(children), step.slice.openStart, step.slice.openEnd);
  return Step.fromJSON(schema, { ...raw, slice: slice.toJSON() });
}

/**
 * Asserts structural separation between private tags and product state.
 * @param document - The real product document.
 * @throws {BodyProvenanceError} If a sidecar mark or attribute reached it.
 */
function assertProductHasNoTrace(document: PMNode): void {
  assertBodyProvenance(!document.marks.some((mark) => mark.type.name === BODY_TRACE_MARK), 'Private source mark reached the product document');
  document.descendants((node) => {
    assertBodyProvenance(!Object.hasOwn(node.attrs, BODY_TRACE_MARK) && !node.marks.some((mark) => mark.type.name === BODY_TRACE_MARK), 'Private source tag reached the product document');
  });
}

/** Executes the same installed fitter with a private occurrence-tagged mirror. */
export class BodyOriginMirror {
  readonly tr: Transaction;
  readonly initial: readonly BodyInlineUnit[];
  readonly ordinal: number;
  private readonly schema: Schema;
  private readonly mirrorSchema: Schema;
  private readonly shadow: Transaction;
  private readonly registry: MirrorRegistry;
  private readonly realBase: number;
  private readonly options: BodyOriginMirrorOptions;
  private readonly recorded: BodyTransferOperation[] = [];

  /**
   * Seeds the private mirror with the binding's current occurrence names.
   * @param transaction - The real command transaction at its current stage.
   * @param options - Current source names and this transaction's ordinal.
   * @param continuation - The private state shared by a forked command.
   * @throws {BodyProvenanceError} If source names or schema premises are invalid.
   * @throws {RangeError} If ProseMirror rejects a cloned node.
   */
  constructor(transaction: Transaction, options: BodyOriginMirrorOptions, continuation?: MirrorContinuation) {
    this.tr = transaction;
    this.schema = transaction.doc.type.schema;
    this.options = options;
    this.ordinal = options.ordinal ?? 0;
    this.mirrorSchema = continuation?.schema ?? makeMirrorSchema(this.schema);
    this.registry = continuation?.registry ?? { prefix: `body-mirror:${mirrorSequence++}`, origins: new Map(), sequence: 0, operations: 0 };
    this.realBase = transaction.steps.length - (continuation?.shadow.steps.length ?? 0);
    this.shadow = continuation?.shadow ?? EditorState.create({ schema: this.mirrorSchema, doc: this.clone(transaction.doc, 'existing', -1) }).tr;
    this.initial = this.readUnits();
    this.verify();
  }

  /**
   * Reads the operations produced by this mirror and its adopted children.
   * @returns Immutable producer descriptions in actual execution order.
   * @throws {never}
   */
  get operations(): readonly BodyTransferOperation[] {
    return Object.freeze([...this.recorded]);
  }

  /**
   * Names one actual existing occurrence or one new copy occurrence.
   * @param kind - Whether the occurrence already has a source name.
   * @param position - Its current product position when it already exists.
   * @returns A unique name confined to this source index or batch.
   * @throws {BodyProvenanceError} If a source name is absent or duplicated.
   */
  private token(kind: BodyUnitOrigin, position?: number): string {
    const token = kind === 'existing'
      ? this.options.sourceAt.get(position ?? -1)
      : this.options.allocate?.('fresh') ?? `${this.registry.prefix}:fresh:${this.registry.sequence++}`;
    assertBodyProvenance(typeof token === 'string' && token.length > 0, 'Missing bound source occurrence');
    assertBodyProvenance(!this.registry.origins.has(token), 'Duplicate allocated source identity');
    this.registry.origins.set(token, kind === 'existing' ? this.options.sourceOrigins?.get(token) ?? 'existing' : 'fresh');
    return token;
  }

  /**
   * Recreates semantic marks in the isolated schema.
   * @param marks - The actual semantic mark set.
   * @returns The corresponding private-schema semantic marks.
   * @throws {RangeError} If a mark type is unknown.
   */
  private copyMarks(marks: readonly Mark[]): Mark[] {
    return marks.map((mark) => this.mirrorSchema.mark(mark.type.name, mark.attrs));
  }

  /**
   * Tags each occurrence independently while cloning the current product tree.
   * @param node - The actual node occurrence.
   * @param kind - Whether its inline occurrences are existing or fresh.
   * @param before - The actual position before this node.
   * @returns A node that exists only in the private schema.
   * @throws {BodyProvenanceError} If an existing source name is missing.
   * @throws {RangeError} If the schema rejects a node.
   */
  private clone(node: PMNode, kind: BodyUnitOrigin, before = -1): PMNode {
    assertBodyProvenance(!node.isText, 'Text is cloned by its parent at unit boundaries');
    const attrs: Record<string, unknown> = { ...node.attrs };
    if (node.isInline && node.isLeaf) attrs[BODY_TRACE_MARK] = this.token(kind, before);
    const children: PMNode[] = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        const text = child.text!;
        for (let index = 0; index < text.length; index += 1) {
          const token = this.token(kind, before + 1 + offset + index);
          children.push(this.mirrorSchema.text(text.charAt(index), [...this.copyMarks(child.marks), this.mirrorSchema.mark(BODY_TRACE_MARK, { token })]));
        }
      } else {
        children.push(this.clone(child, kind, before + 1 + offset));
      }
    });
    return this.mirrorSchema.nodes[node.type.name].create(attrs, children, this.copyMarks(node.marks));
  }

  /**
   * Reads private tags as an occurrence index with ordinary product positions.
   * @returns Current identities without exposing the private schema or nodes.
   * @throws {BodyProvenanceError} If a tag is missing or appears twice.
   * @throws {RangeError} If ProseMirror cannot resolve a position.
   */
  readUnits(): readonly BodyInlineUnit[] {
    const result: BodyInlineUnit[] = [];
    this.shadow.doc.descendants((node, pos) => {
      if (!node.isText && !(node.isInline && node.isLeaf)) return;
      const raw: unknown = node.isText
        ? node.marks.find((mark) => mark.type.name === BODY_TRACE_MARK)?.attrs['token']
        : node.attrs[BODY_TRACE_MARK];
      assertBodyProvenance(typeof raw === 'string', 'Missing private source occurrence');
      const origin = this.registry.origins.get(raw);
      assertBodyProvenance(origin !== undefined, 'Unknown private source occurrence');
      assertBodyProvenance(!node.isText || node.text!.length === 1, 'A private text unit must have one source name');
      result.push(Object.freeze({ token: raw, origin, pos, width: node.isText ? 1 : node.nodeSize, value: node.isText ? node.text! : `<${node.type.name}>`, block: blockAt(this.shadow.doc, pos) }));
    });
    assertBodyProvenance(new Set(result.map((unit) => unit.token)).size === result.length, 'Repeated private source identity');
    return Object.freeze(result);
  }

  /**
   * Compares every real fitted step and final document after removing tags.
   * @throws {BodyProvenanceError} If either installed fitter diverges.
   * @throws {RangeError} If a stripped step or document is invalid.
   */
  verify(): void {
    this.verifyFitter();
    const before = this.tr.docs[this.realBase] ?? this.tr.doc;
    const tail = EditorState.create({ schema: this.schema, doc: before }).tr;
    this.tr.steps.slice(this.realBase).forEach((step) => tail.step(step));
    for (const operation of bodyOperations(this.tr)) {
      if (operation.source.step < this.realBase) {
        assertBodyProvenance(operation.target.step <= this.realBase, 'A source operation crosses an unobserved mirror boundary');
        continue;
      }
      const source = { transaction: 0, step: operation.source.step - this.realBase };
      const target = { transaction: 0, step: operation.target.step - this.realBase };
      recordBodyOperation(tail, {
        ...operation, source, target,
        handoffs: operation.handoffs.map((handoff) => ({
          ...handoff,
          source: { ...handoff.source, boundary: { transaction: 0, step: handoff.source.boundary.step - this.realBase } },
          target: { ...handoff.target, boundary: { transaction: 0, step: handoff.target.boundary.step - this.realBase } },
        })),
      });
    }
    const replayed = replayBodyJournal(before, this.initial, [tail], { batchId: `${this.registry.prefix}:verification` });
    assertBodyProvenance(
      JSON.stringify(replayed.units.map((unit) => [unit.token, unit.origin, unit.pos, unit.width, unit.value, unit.block])) ===
      JSON.stringify(this.readUnits().map((unit) => [unit.token, unit.origin, unit.pos, unit.width, unit.value, unit.block])),
      'Private source replay differs from the producer metadata',
    );
  }

  /**
   * Compares the installed fitter's structural effects before publishing metadata.
   * @throws {BodyProvenanceError} If real and private structures differ.
   * @throws {RangeError} If the product schema rejects a stripped step.
   */
  private verifyFitter(): void {
    assertBodyProvenance(stripDocument(this.shadow.doc, this.schema).eq(this.tr.doc), 'Private fitter final document diverged');
    assertBodyProvenance(this.tr.steps.length - this.realBase === this.shadow.steps.length, 'Private fitter step count diverged');
    for (let index = 0; index < this.shadow.steps.length; index += 1) {
      const stripped = stripStep(this.shadow.steps[index], this.schema);
      assertBodyProvenance(JSON.stringify(stripped.toJSON()) === JSON.stringify(this.tr.steps[this.realBase + index].toJSON()), 'Private fitter step differs from the actual step');
    }
    assertProductHasNoTrace(this.tr.doc);
    this.readUnits();
  }

  /**
   * Captures selected names at the current actual boundary.
   * @param from - The inclusive source position.
   * @param to - The exclusive source position.
   * @returns The complete selected inline occurrences.
   * @throws {BodyProvenanceError} If an inline leaf is only partly selected.
   */
  private capture(from: number, to: number): readonly BodyInlineUnit[] {
    const selected = this.readUnits().filter((unit) => unit.pos >= from && unit.pos < to);
    assertBodyProvenance(selected.every((unit) => unit.pos + unit.width <= to), 'Partial source inline leaf selection');
    return selected;
  }

  /**
   * Emits one complete command effect including fitter-preserved occurrences.
   * @param name - The semantic producer operation.
   * @param kind - The intent of explicitly selected source ranges.
   * @param step - The source boundary in the real transaction.
   * @param selected - The source names intentionally moved or preserved.
   * @param open - The actual fitted slice when there is one.
   * @param before - All source names before the command.
   * @returns The immutable metadata written to the real transaction.
   * @throws {BodyProvenanceError} If the actual and private effects differ.
   * @throws {RangeError} If ProseMirror rejects a stripped step.
   */
  private finish(name: string, kind: 'move' | 'preserve', step: number, selected: readonly BodyInlineUnit[], open: Slice | undefined, before: readonly BodyInlineUnit[]): BodyTransferOperation {
    this.verifyFitter();
    const after = this.readUnits();
    const destinations = new Map(after.map((unit) => [unit.token, unit]));
    const selectedNames = new Set(selected.map((unit) => unit.token));
    const oldNames = new Set(before.map((unit) => unit.token));
    const source = { transaction: this.ordinal, step };
    const target = { transaction: this.ordinal, step: this.tr.steps.length };
    const mapping = this.tr.mapping.slice(step);
    const handoffs: BodyHandoff[] = [];
    const dropped: string[] = [];
    for (const unit of before) {
      const destination = destinations.get(unit.token);
      if (destination === undefined) {
        dropped.push(unit.token);
        continue;
      }
      const left = mapping.mapResult(unit.pos, 1);
      const right = mapping.mapResult(unit.pos + unit.width, -1);
      const carried = !left.deleted && !right.deleted && left.pos === destination.pos && right.pos === destination.pos + destination.width;
      if (selectedNames.has(unit.token) || !carried) {
        handoffs.push({ token: unit.token, kind: selectedNames.has(unit.token) ? kind : 'preserve',
          source: { boundary: source, from: unit.pos, to: unit.pos + unit.width, block: unit.block },
          target: { boundary: target, from: destination.pos, to: destination.pos + destination.width, block: destination.block },
        });
      }
    }
    const operation: BodyTransferOperation = {
      id: `${this.registry.prefix}:operation:${this.registry.operations++}`,
      name, source, target, handoffs, dropped,
      created: after.filter((unit) => !oldNames.has(unit.token)),
      ...(open === undefined ? {} : { openStart: open.openStart, openEnd: open.openEnd }),
    };
    recordBodyOperation(this.tr, operation);
    const recorded = bodyOperations(this.tr).at(-1)!;
    this.recorded.push(recorded);
    this.verify();
    return recorded;
  }

  /**
   * Moves a live text range through the installed selection fitter.
   * @param from - The current inclusive source position.
   * @param to - The current exclusive source position.
   * @param drop - The target position before source removal.
   * @returns The complete fitted source operation.
   * @throws {BodyProvenanceError} If either fitter diverges.
   * @throws {RangeError} If a position cannot be resolved.
   */
  moveRange(from: number, to: number, drop: number): BodyTransferOperation {
    return this.moveSelection(TextSelection.create(this.tr.doc, from, to), drop);
  }

  /**
   * Uses the current selection content for the real and private drop paths.
   * @param selection - The live source selection.
   * @param drop - The target in the current document.
   * @param normalize - The same pure product slice rule for both schemas.
   * @returns The complete move, including a source-preserving no-op at its own range.
   * @throws {BodyProvenanceError} If fitting changes a declared source unexpectedly.
   * @throws {RangeError} If ProseMirror rejects the selection or target.
   */
  moveSelection(selection: Selection, drop: number, normalize?: (slice: Slice, source: Selection) => Slice): BodyTransferOperation {
    const step = this.tr.steps.length;
    const shadowStep = this.shadow.steps.length;
    const before = this.readUnits();
    const { from, to } = selection;
    if (drop >= from && drop <= to) return this.finish('internal selection drop', 'preserve', step, [], undefined, before);
    const selected = this.capture(from, to);
    this.tr.setSelection(selection);
    this.shadow.setSelection(Selection.fromJSON(this.shadow.doc, selection.toJSON()));
    const slice = normalize?.(this.tr.selection.content(), this.tr.selection) ?? this.tr.selection.content();
    const mirrored = normalize?.(this.shadow.selection.content(), this.shadow.selection) ?? this.shadow.selection.content();
    const realDrop = dropPoint(this.tr.doc, drop, slice) ?? drop;
    const shadowDrop = dropPoint(this.shadow.doc, drop, mirrored) ?? drop;
    assertBodyProvenance(realDrop === shadowDrop, 'Private drop point differs from the actual fitter');
    this.tr.deleteSelection();
    this.shadow.deleteSelection();
    const landing = this.tr.mapping.slice(step).map(realDrop);
    const shadowLanding = this.shadow.mapping.slice(shadowStep).map(shadowDrop);
    assertBodyProvenance(landing === shadowLanding, 'Private drop mapping differs from the actual fitter');
    const isNode = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1;
    if (isNode) {
      this.tr.replaceRangeWith(landing, landing, slice.content.firstChild!);
      this.shadow.replaceRangeWith(shadowLanding, shadowLanding, mirrored.content.firstChild!);
    } else {
      this.tr.replaceRange(landing, landing, slice);
      this.shadow.replaceRange(shadowLanding, shadowLanding, mirrored);
    }
    const resolved = this.tr.doc.resolve(landing);
    if (isNode && NodeSelection.isSelectable(slice.content.firstChild!) && resolved.nodeAfter?.sameMarkup(slice.content.firstChild!)) {
      this.tr.setSelection(new NodeSelection(resolved));
    } else {
      let end = landing;
      this.tr.mapping.maps.at(-1)?.forEach((_from, _to, _newFrom, newTo) => { end = newTo; });
      this.tr.setSelection(TextSelection.between(resolved, this.tr.doc.resolve(end)));
    }
    this.shadow.setSelection(Selection.fromJSON(this.shadow.doc, this.tr.selection.toJSON()));
    this.tr.setMeta('uiEvent', 'drop');
    return this.finish('internal selection drop', 'move', step, selected, slice, before);
  }

  /**
   * Runs one actual command against the real and isolated states.
   * @param name - The semantic command name.
   * @param from - The current selected source start.
   * @param to - The current selected source end.
   * @param selection - The command's actual selection.
   * @param command - The same installed command for both states.
   * @returns Its complete source effect.
   * @throws {BodyProvenanceError} If the command refuses or the two effects differ.
   * @throws {RangeError} If a command step is invalid.
   */
  nativeMove(name: string, from: number, to: number, selection: Selection, command: BodyNativeCommand): BodyTransferOperation {
    const step = this.tr.steps.length;
    const before = this.readUnits();
    const selected = this.capture(from, to);
    const state = EditorState.create({ schema: this.schema, doc: this.tr.doc, selection });
    const shadowState = EditorState.create({ schema: this.mirrorSchema, doc: this.shadow.doc, selection: Selection.fromJSON(this.shadow.doc, selection.toJSON()) });
    const produced: Transaction[] = [];
    const mirrored: Transaction[] = [];
    assertBodyProvenance(command(state, (transaction) => { produced.push(transaction); }), 'Source-preserving command refused');
    assertBodyProvenance(command(shadowState, (transaction) => { mirrored.push(transaction); }), 'Private source-preserving command refused');
    assertBodyProvenance(produced.length === 1 && mirrored.length === 1, 'Source command must produce one complete transaction');
    const actual = produced[0];
    const privateTransaction = mirrored[0];
    actual.steps.forEach((value) => this.tr.step(value));
    privateTransaction.steps.forEach((value) => this.shadow.step(value));
    this.tr.setSelection(Selection.fromJSON(this.tr.doc, actual.selection.toJSON()));
    this.shadow.setSelection(Selection.fromJSON(this.shadow.doc, privateTransaction.selection.toJSON()));
    if (actual.storedMarksSet) this.tr.setStoredMarks(actual.storedMarks);
    if (privateTransaction.storedMarksSet) this.shadow.setStoredMarks(privateTransaction.storedMarks);
    if (actual.scrolledIntoView) this.tr.scrollIntoView();
    return this.finish(name, 'move', step, selected, undefined, before);
  }

  /**
   * Fits a copy while giving every copied occurrence a fresh label.
   * @param position - The actual insertion position.
   * @param slice - The copied product content.
   * @returns The fitted copy effect.
   * @throws {BodyProvenanceError} If the real and private fitter diverge.
   * @throws {RangeError} If the slice cannot be fitted.
   */
  insertCopy(position: number, slice: Slice): BodyTransferOperation {
    const before = this.readUnits();
    const children: PMNode[] = [];
    slice.content.forEach((node) => {
      if (node.isText) {
        for (let index = 0; index < node.text!.length; index += 1) {
          children.push(this.mirrorSchema.text(node.text!.charAt(index), [...this.copyMarks(node.marks), this.mirrorSchema.mark(BODY_TRACE_MARK, { token: this.token('fresh') })]));
        }
      } else {
        children.push(this.clone(node, 'fresh'));
      }
    });
    const step = this.tr.steps.length;
    this.tr.replaceRange(position, position, slice);
    this.shadow.replaceRange(position, position, new Slice(Fragment.fromArray(children), slice.openStart, slice.openEnd));
    return this.finish('fresh copy', 'preserve', step, [], slice, before);
  }

  /**
   * Replaces structural frames using each state's own current content.
   * @param from - The actual replacement start.
   * @param to - The actual replacement end.
   * @param make - The same structural producer for both schemas.
   * @returns Its complete preserved-source operation.
   * @throws {BodyProvenanceError} If the source operation diverges.
   * @throws {RangeError} If the generated content is invalid.
   */
  replaceFromCurrent(from: number, to: number, make: (document: PMNode, schema: Schema) => Fragment): BodyTransferOperation {
    const step = this.tr.steps.length;
    const before = this.readUnits();
    const selected = this.capture(from, to);
    this.tr.replaceWith(from, to, make(this.tr.doc, this.schema));
    this.shadow.replaceWith(from, to, make(this.shadow.doc, this.mirrorSchema));
    return this.finish('preserve current structured content', 'preserve', step, selected, undefined, before);
  }

  /**
   * Applies a structural attribute change without copying any occurrences.
   * @param position - The node's actual current position.
   * @param attrs - The semantic attributes to set.
   * @throws {BodyProvenanceError} If the node is absent or fitting diverges.
   * @throws {RangeError} If ProseMirror rejects the markup.
   */
  setNodeMarkup(position: number, attrs: Readonly<Record<string, unknown>>): void {
    const actual = this.tr.doc.nodeAt(position);
    const mirrored = this.shadow.doc.nodeAt(position);
    assertBodyProvenance(actual !== null && mirrored !== null, 'Source markup node is absent');
    this.tr.setNodeMarkup(position, undefined, { ...actual.attrs, ...attrs });
    this.shadow.setNodeMarkup(position, undefined, { ...mirrored.attrs, ...attrs });
    this.verify();
  }

  /**
   * Forks a child or appended command with the same current source names.
   * @param selection - The child's current selection.
   * @param nextTransaction - Whether the child belongs to the next accepted transaction.
   * @returns An isolated command mirror sharing this batch's allocation scope.
   * @throws {BodyProvenanceError} If the fork cannot preserve current source names.
   * @throws {RangeError} If the selection is invalid.
   */
  fork(selection: Selection = this.tr.selection, nextTransaction = false): BodyOriginMirror {
    const real = EditorState.create({ schema: this.schema, doc: this.tr.doc, selection }).tr;
    const shadow = EditorState.create({ schema: this.mirrorSchema, doc: this.shadow.doc, selection: Selection.fromJSON(this.shadow.doc, selection.toJSON()) }).tr;
    const sourceAt = new Map(this.readUnits().map((unit) => [unit.pos, unit.token]));
    return new BodyOriginMirror(real, { ...this.options, sourceAt, ordinal: this.ordinal + (nextTransaction ? 1 : 0) }, { shadow, schema: this.mirrorSchema, registry: this.registry });
  }

  /**
   * Adopts a child's exact steps and rebased source metadata.
   * @param child - A command forked from this current document.
   * @throws {BodyProvenanceError} If its transaction or source state is unrelated.
   * @throws {RangeError} If an adopted step no longer applies.
   */
  adopt(child: BodyOriginMirror): void {
    assertBodyProvenance(child.ordinal === this.ordinal && child.registry === this.registry, 'A source child belongs to another transaction');
    assertBodyProvenance(child.tr.before.eq(this.tr.doc) && child.shadow.before.eq(this.shadow.doc), 'Source child before document differs');
    const stepOffset = this.tr.steps.length;
    child.tr.steps.forEach((step) => this.tr.step(step));
    child.shadow.steps.forEach((step) => this.shadow.step(step));
    this.tr.setSelection(Selection.fromJSON(this.tr.doc, child.tr.selection.toJSON()));
    this.shadow.setSelection(Selection.fromJSON(this.shadow.doc, child.shadow.selection.toJSON()));
    if (child.tr.storedMarksSet) this.tr.setStoredMarks(child.tr.storedMarks);
    for (const operation of child.operations) {
      const rebased = rebaseBodyOperation(operation, { stepOffset, transaction: this.ordinal });
      recordBodyOperation(this.tr, rebased);
      this.recorded.push(bodyOperations(this.tr).at(-1)!);
    }
    this.verify();
  }
}
