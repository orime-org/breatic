// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as Y from "yjs";

/** JSON carried by the document's own persistent descriptors. */
export type BodyJsonValue = null | boolean | number | string | readonly BodyJsonValue[] | BodyJsonObject;

/** Named JSON fields, including payloads from an unknown product vocabulary. */
export interface BodyJsonObject {
  readonly [key: string]: BodyJsonValue;
}

/** A document's permanent root. */
export interface BodyRootRecord {
  readonly id: string;
  readonly kind: "root";
  readonly attrs: BodyJsonObject;
}

/** The registered parent and initial sibling order of a node. */
export interface BodyRecordPlacement {
  readonly id: string;
  readonly parent: string;
  readonly order: string;
}

/** A structural product node, such as a group, table, row or cell. */
export interface BodyContainerRecord extends BodyRecordPlacement {
  readonly kind: "container";
  readonly type: string;
  readonly attrs: BodyJsonObject;
}

/** A body block whose inline content lives in a separately movable facet. */
export interface BodyOwnerRecord extends BodyRecordPlacement {
  readonly kind: "owner";
  readonly type: string;
  readonly attrs: BodyJsonObject;
  readonly wrapperAttrs: BodyJsonObject;
  readonly facet: string;
  readonly base: boolean;
}

/** The movable inline-content branch initially attached to its owner. */
export interface BodyFacetRecord extends BodyRecordPlacement {
  readonly kind: "facet";
  readonly owner: string;
}

/** An immutable node descriptor. Cut-derived nodes are computed from sources. */
export type BodyRecord = BodyRootRecord | BodyContainerRecord | BodyOwnerRecord | BodyFacetRecord;

/** A permanent native text source and its boundary identities. */
export interface BodySource {
  readonly id: string;
  readonly facet: string;
  readonly head: string;
  readonly tail: string;
}

/** A complete parent-history candidate emitted by one structural action. */
export interface BodyParentEdge {
  readonly child: string;
  readonly parent: string;
  readonly counter: number;
  readonly order: string;
}

/** Shared identity, history group and structural dependencies of a fact. */
export interface BodyFactBase {
  readonly id: string;
  readonly group: string;
  readonly dependencies: readonly string[];
}

/** A user's new empty owner is visible while its birth is enabled. */
export interface BodyBirthFact extends BodyFactBase {
  readonly kind: "birth";
  readonly owner: string;
}

/** All parent edges required by a single semantic structure operation. */
export interface BodyStructureFact extends BodyFactBase {
  readonly kind: "structure";
  readonly edges: readonly BodyParentEdge[];
}

/** A candidate value for one product attribute. */
export interface BodyAttributeFact extends BodyFactBase {
  readonly kind: "attribute";
  readonly owner: string;
  readonly name: string;
  readonly value: BodyJsonValue;
  readonly counter: number;
}

/** A candidate block-content type, independently retained from its attributes. */
export interface BodyNodeKindFact extends BodyFactBase {
  readonly kind: "nodeKind";
  readonly owner: string;
  readonly value: string;
  readonly counter: number;
}

/** A product mark's type and complete attribute payload. */
export interface BodyMarkPayload {
  readonly type: string;
  readonly attrs: BodyJsonObject;
}

/** An immutable mark instance referenced by an actual native mark value. */
export interface BodyMarkFact extends BodyFactBase {
  readonly kind: "mark";
  readonly payload: BodyMarkPayload;
}

/** An explicit user deletion of the owner's current subtree. */
export interface BodyDeleteFact extends BodyFactBase {
  readonly kind: "delete";
  readonly owner: string;
}

/** The document's operation facts, with structural support separate from history. */
export type BodyFact = BodyBirthFact | BodyStructureFact | BodyAttributeFact | BodyNodeKindFact | BodyMarkFact | BodyDeleteFact;

/** One accepted batch's immutable fact identities and history classification. */
export interface BodyGroup {
  readonly id: string;
  readonly facts: readonly string[];
  readonly history: "user" | "machine" | "base";
}

/** The complete structural units needed by an actual surviving inline run. */
export interface BodyContext {
  readonly id: string;
  readonly dependencies: readonly string[];
}

/** The format marker published after all initial records and sources exist. */
export interface BodyMetadata {
  readonly format: "breatic.document.records";
  readonly version: 1;
  readonly seedRoot: string;
}

/** Native roots shared by the binding, service preparation and persistence. */
export interface BodyRecordRoots {
  readonly metadata: Y.Map<unknown>;
  readonly records: Y.Map<string>;
  readonly sources: Y.Map<string>;
  readonly facts: Y.Map<string>;
  readonly groups: Y.Map<string>;
  readonly enabled: Y.Map<boolean>;
  readonly contexts: Y.Map<string>;
}

/** A complete monotonic registration request, validated before its native write. */
export interface BodyRegistration {
  readonly records?: readonly BodyRecord[];
  readonly sources?: readonly BodySource[];
  readonly facts?: readonly BodyFact[];
  readonly groups?: readonly BodyGroup[];
  readonly contexts?: readonly BodyContext[];
}

/** Parsed facts used by the pure tree and product codec. */
export interface BodyRecordsSnapshot {
  readonly metadata: BodyMetadata;
  readonly records: ReadonlyMap<string, BodyRecord>;
  readonly sources: ReadonlyMap<string, BodySource>;
  readonly facts: ReadonlyMap<string, BodyFact>;
  readonly groups: ReadonlyMap<string, BodyGroup>;
  readonly contexts: ReadonlyMap<string, BodyContext>;
  readonly enabled: ReadonlySet<string>;
}

/** An incomplete update is held until its named immutable dependencies arrive. */
export type BodyRecordsRead =
  | { readonly status: "uninitialized" }
  | { readonly status: "pending"; readonly missing: readonly string[] }
  | { readonly status: "ready"; readonly body: BodyRecordsSnapshot };
