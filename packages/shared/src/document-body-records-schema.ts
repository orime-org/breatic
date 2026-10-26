// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

import type {
  BodyContext,
  BodyFact,
  BodyGroup,
  BodyJsonObject,
  BodyJsonValue,
  BodyMetadata,
  BodyRecord,
  BodySource,
} from "@shared/document-body-records-types.js";

/** The self-owned records body format published to editing clients. */
export const DOCUMENT_BODY_FORMAT = "breatic.document.records";

/** The current grammar version of the records body. */
export const DOCUMENT_BODY_FORMAT_VERSION = 1;

/** A descriptor, marker or source boundary violates the stored body contract. */
export class DocumentBodyFormatError extends Error {
  /**
   * Names the boundary that rejected the value.
   * @param message - The invalid boundary or conflicting identity.
   * @param cause - The original validation failure, when available.
   * @throws {never}
   */
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "DocumentBodyFormatError";
  }
}

/**
 * Validates the owned JSON grammar while retaining its exact property names.
 * @param value - An untrusted JSON candidate.
 * @param ancestors - Current object ancestors, used to reject cycles.
 * @returns Whether every serialized field is a valid JSON value.
 * @throws {Error} If a supplied property getter throws.
 */
function isBodyJson(value: unknown, ancestors: Set<object> = new Set()): value is BodyJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? [...value].every((entry) => isBodyJson(entry, ancestors))
    : Object.keys(value).every((key) => isBodyJson((value as Record<string, unknown>)[key], ancestors));
  ancestors.delete(value);
  return valid;
}

/**
 * Validates native payloads against the same JSON grammar as stored descriptors.
 * @param value - The native snapshot payload at the import boundary.
 * @returns The complete original JSON value, including unknown own keys.
 * @throws {DocumentBodyFormatError} If the payload is not representable by this format.
 */
export function parseBodyJsonValue(value: unknown): BodyJsonValue {
  if (!isBodyJson(value)) throw new DocumentBodyFormatError("Invalid native body JSON payload");
  return value;
}

const identifier = z.string().min(1);
// Zod's record parser strips __proto__; these fields carry opaque product JSON.
const jsonValue: z.ZodType<BodyJsonValue> = z.custom<BodyJsonValue>((value) => isBodyJson(value));
const jsonObject: z.ZodType<BodyJsonObject> = z.custom<BodyJsonObject>((value) => (
  typeof value === "object" && value !== null && !Array.isArray(value) && isBodyJson(value)
));
const placement = { id: identifier, parent: identifier, order: z.string() };
const factBase = { id: identifier, group: identifier, dependencies: z.array(identifier) };
const counter = z.number().int().nonnegative();

/** The self-owned node grammar, with product vocabularies retained as data. */
export const bodyRecordSchema: z.ZodType<BodyRecord> = z.discriminatedUnion("kind", [
  z.strictObject({ id: identifier, kind: z.literal("root"), attrs: jsonObject }),
  z.strictObject({ ...placement, kind: z.literal("container"), type: identifier, attrs: jsonObject }),
  z.strictObject({
    ...placement, kind: z.literal("owner"), type: identifier, attrs: jsonObject,
    wrapperAttrs: jsonObject, facet: identifier, base: z.boolean(),
  }),
  z.strictObject({ ...placement, kind: z.literal("facet"), owner: identifier }),
]);

/** Native sources keep permanent, distinct first and last cut identities. */
export const bodySourceSchema: z.ZodType<BodySource> = z.strictObject({
  id: identifier, facet: identifier, head: identifier, tail: identifier,
}).refine((source) => source.head !== source.tail, "Source boundaries must be distinct");

/** One indivisible effect contains every parent edge it requires. */
export const bodyFactSchema: z.ZodType<BodyFact> = z.discriminatedUnion("kind", [
  z.strictObject({ ...factBase, kind: z.literal("birth"), owner: identifier }),
  z.strictObject({
    ...factBase, kind: z.literal("structure"),
    edges: z.array(z.strictObject({ child: identifier, parent: identifier, counter, order: z.string() })).min(1),
  }),
  z.strictObject({ ...factBase, kind: z.literal("attribute"), owner: identifier, name: identifier, value: jsonValue, counter }),
  z.strictObject({ ...factBase, kind: z.literal("nodeKind"), owner: identifier, value: identifier, counter }),
  z.strictObject({
    ...factBase, kind: z.literal("mark"),
    payload: z.strictObject({ type: identifier, attrs: jsonObject }),
  }),
  z.strictObject({ ...factBase, kind: z.literal("delete"), owner: identifier }),
]);

/** Batch membership is immutable; native history changes its enabled key. */
export const bodyGroupSchema: z.ZodType<BodyGroup> = z.strictObject({
  id: identifier, facts: z.array(identifier), history: z.enum(["user", "machine", "base"]),
});

/** A live run's dependency list names complete structural facts. */
export const bodyContextSchema: z.ZodType<BodyContext> = z.strictObject({
  id: identifier, dependencies: z.array(identifier),
});

/** The current records body marker. */
export const bodyMetadataSchema: z.ZodType<BodyMetadata> = z.strictObject({
  format: z.literal(DOCUMENT_BODY_FORMAT), version: z.literal(DOCUMENT_BODY_FORMAT_VERSION), seedRoot: identifier,
});

/**
 * Validates a typed descriptor at a native storage boundary.
 * @param schema - The grammar for this registry.
 * @param value - The decoded or newly supplied value.
 * @param label - The registry and identity for diagnostics.
 * @returns The validated descriptor.
 * @throws {DocumentBodyFormatError} If the value violates the registry grammar.
 */
export function parseBodyDescription<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  try {
    if (!isBodyJson(value)) throw new DocumentBodyFormatError(`Invalid JSON in ${label}`);
    const result = schema.safeParse(value);
    if (!result.success) throw new DocumentBodyFormatError(`Invalid ${label}`, result.error);
    if (encodeBodyDescription(result.data) !== encodeBodyDescription(value)) {
      throw new DocumentBodyFormatError(`Unexpected fields in ${label}`);
    }
    return result.data;
  } catch (error) {
    if (error instanceof DocumentBodyFormatError) throw error;
    throw new DocumentBodyFormatError(`Invalid ${label}`, error);
  }
}

/**
 * Validates one stored descriptor and its enclosing registry identity.
 * @param schema - The descriptor grammar.
 * @param value - The native map's stored JSON string.
 * @param id - The native map key.
 * @param label - The registry name.
 * @returns The matching descriptor.
 * @throws {DocumentBodyFormatError} If JSON, grammar or identity is invalid.
 */
export function decodeBodyDescription<T extends { readonly id: string }>(
  schema: z.ZodType<T>, value: unknown, id: string, label: string,
): T {
  if (typeof value !== "string") throw new DocumentBodyFormatError(`Invalid ${label}:${id}`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch (error) {
    throw new DocumentBodyFormatError(`Invalid JSON in ${label}:${id}`, error);
  }
  const result = parseBodyDescription(schema, decoded, `${label}:${id}`);
  if (result.id !== id) throw new DocumentBodyFormatError(`Mismatched identity in ${label}:${id}`);
  return result;
}

/**
 * Recursively orders the fields of an already validated JSON value.
 * @param value - A validated descriptor or JSON field.
 * @returns The same value with deterministic object key order.
 * @throws {never}
 */
function orderedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key, orderedJson((value as Record<string, unknown>)[key]),
  ]));
}

/**
 * Encodes a validated descriptor with one deterministic field ordering.
 * @param value - A validated registry descriptor.
 * @returns Its canonical JSON string.
 * @throws {DocumentBodyFormatError} If the value cannot be encoded as JSON.
 */
export function encodeBodyDescription(value: unknown): string {
  try {
    const encoded = JSON.stringify(orderedJson(value));
    if (encoded === undefined) throw new DocumentBodyFormatError("Invalid body descriptor JSON");
    return encoded;
  } catch (error) {
    if (error instanceof DocumentBodyFormatError) throw error;
    throw new DocumentBodyFormatError("Invalid body descriptor JSON", error);
  }
}
