// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * An upstream's input (or output) JSON schema reduced to what a binding is checked against:
 * every field by dotted path, each shape it accepts, and the fields it requires. The price
 * and schema sync (`scripts/provider-prices.ts`) writes one snapshot per bound endpoint;
 * the configuration tests read them. Runtime code never reads a snapshot.
 */

/** One shape a field accepts. */
export interface Leaf {
  /** A JSON schema type, or `any` when the schema names none. */
  type: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  /** For an object: the sub-fields it requires when it is sent. */
  required?: string[];
  /** For an array: each item's fields (a scalar item's shapes under the key "") and required ones. */
  items?: { fields: Record<string, Leaf[]>; required: string[] };
}

/** One upstream endpoint's schema, reduced. */
export interface SchemaSnapshot {
  /** Where the schema was read from. */
  source: string;
  /** Every field by dotted path, with each shape it accepts. */
  fields: Record<string, Leaf[]>;
  /** The top-level fields every request carries. */
  required: string[];
  /** The result's fields, for an upstream that publishes its result schema. */
  outputs?: Record<string, Leaf[]>;
  /** The execution modes the upstream runs the endpoint in (SandBase). */
  modes?: string[];
}

/** A JSON schema node as read. */
type Node = Record<string, unknown>;

/** How deep `$ref`s may nest before a cycle is assumed. */
const MAX_DEPTH = 32;

/**
 * Whether a value is a plain object.
 * @param value - The value.
 * @returns True for a non-null, non-array object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A schema node with its `$ref` resolved against the root and its `allOf` merged in.
 * @param node - The node.
 * @param root - The document references point into.
 * @param depth - How many references were followed to get here.
 * @returns The resolved node.
 * @throws {Error} When a reference does not resolve or references nest too deep.
 */
function resolved(node: Node, root: unknown, depth: number): Node {
  if (depth > MAX_DEPTH) throw new Error("Schema references nest too deep");
  let out = node;
  const ref = out.$ref;
  if (typeof ref === "string") {
    const target = ref.replace(/^#\//, "").split("/").reduce<unknown>((at, key) => (isObject(at) ? at[key.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined), root);
    if (!isObject(target)) throw new Error(`Schema reference ${ref} does not resolve`);
    const { $ref: _ref, ...siblings } = out;
    out = { ...resolved(target, root, depth + 1), ...siblings };
  }
  if (Array.isArray(out.allOf)) {
    const { allOf, ...rest } = out;
    const parts = (allOf as unknown[]).filter(isObject).map((part) => resolved(part, root, depth + 1));
    const properties = Object.assign({}, ...parts.map((p) => (isObject(p.properties) ? p.properties : {})), isObject(rest.properties) ? rest.properties : {}) as Node;
    const required = [...parts.flatMap((p) => (Array.isArray(p.required) ? p.required : [])), ...(Array.isArray(rest.required) ? rest.required : [])];
    out = { ...Object.assign({}, ...parts), ...rest, ...(Object.keys(properties).length > 0 ? { properties } : {}), ...(required.length > 0 ? { required } : {}) };
  }
  return out;
}

/**
 * The branches a node accepts: each `anyOf` and `oneOf` branch, each type of a type list, and a null branch when it is nullable.
 * @param node - The resolved node.
 * @param root - The document references point into.
 * @param depth - How many references were followed.
 * @returns One node per accepted shape.
 * @throws {Error} When a reference does not resolve.
 */
function branches(node: Node, root: unknown, depth: number): Node[] {
  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  if (union !== undefined) {
    const { anyOf: _a, oneOf: _o, ...rest } = node;
    return (union as unknown[]).filter(isObject).flatMap((branch) => branches(resolved({ ...rest, ...branch }, root, depth + 1), root, depth + 1));
  }
  const out = Array.isArray(node.type) ? (node.type as unknown[]).map((type) => ({ ...node, type })) : [node];
  return node.nullable === true && !out.some((b) => b.type === "null") ? [...out, { type: "null" }] : out;
}

/**
 * A number of a node, if it is one.
 * @param value - The value.
 * @returns The number, or undefined.
 */
function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * The type a node names, or the one its enum or const implies.
 * @param node - The node.
 * @returns The type.
 */
function typeOf(node: Node): string {
  if (typeof node.type === "string") return node.type;
  if (isObject(node.properties)) return "object";
  if (node.items !== undefined) return "array";
  return "any";
}

/**
 * Record every shape a node accepts at a path, and the sub-fields of its object shapes.
 * @param node - The node.
 * @param path - The dotted path; "" for the root.
 * @param root - The document references point into.
 * @param fields - Where shapes go.
 * @param depth - How many references were followed.
 * @throws {Error} When a reference does not resolve.
 */
function collect(node: Node, path: string, root: unknown, fields: Record<string, Leaf[]>, depth: number): void {
  for (const branch of branches(resolved(node, root, depth), root, depth)) {
    const leaf: Leaf = { type: typeOf(branch) };
    const values = Array.isArray(branch.enum) ? branch.enum : "const" in branch ? [branch.const] : undefined;
    if (values !== undefined) leaf.enum = values;
    const minimum = num(branch.minimum);
    const maximum = num(branch.maximum);
    // OpenAPI 3.0 writes exclusive bounds as booleans beside minimum and maximum.
    const exclusiveMinimum = branch.exclusiveMinimum === true ? minimum : num(branch.exclusiveMinimum);
    const exclusiveMaximum = branch.exclusiveMaximum === true ? maximum : num(branch.exclusiveMaximum);
    if (exclusiveMinimum !== undefined) leaf.exclusiveMinimum = exclusiveMinimum;
    else if (minimum !== undefined) leaf.minimum = minimum;
    if (exclusiveMaximum !== undefined) leaf.exclusiveMaximum = exclusiveMaximum;
    else if (maximum !== undefined) leaf.maximum = maximum;
    const minItems = num(branch.minItems);
    const maxItems = num(branch.maxItems);
    if (minItems !== undefined) leaf.minItems = minItems;
    if (maxItems !== undefined) leaf.maxItems = maxItems;
    if (leaf.type === "array" && isObject(branch.items)) {
      const items: Record<string, Leaf[]> = {};
      collect(branch.items, "", root, items, depth + 1);
      const item = resolved(branch.items, root, depth + 1);
      leaf.items = { fields: items, required: Array.isArray(item.required) ? item.required.map(String) : [] };
    }
    if (leaf.type === "object") {
      const required = Array.isArray(branch.required) ? branch.required.map(String) : [];
      if (required.length > 0) leaf.required = required;
      for (const [key, sub] of Object.entries(isObject(branch.properties) ? branch.properties : {})) {
        if (isObject(sub)) collect(sub, path === "" ? key : `${path}.${key}`, root, fields, depth + 1);
      }
    }
    (fields[path] ??= []).push(leaf);
  }
}

/**
 * Reduce one JSON schema to a snapshot.
 * @param schema - The schema, possibly a `$ref`.
 * @param options - `root`, the document its references point into, and `source`, where it was read.
 * @param options.root - The document references point into.
 * @param options.source - Where the schema was read from.
 * @returns The snapshot.
 * @throws {Error} When a reference does not resolve.
 */
export function snapshotOf(schema: unknown, options: { root: unknown; source: string }): SchemaSnapshot {
  const fields: Record<string, Leaf[]> = {};
  if (!isObject(schema)) return { source: options.source, fields, required: [] };
  collect(schema, "", options.root, fields, 0);
  const top = fields[""] ?? [];
  delete fields[""];
  const required = [...new Set(top.flatMap((leaf) => leaf.required ?? []))];
  return { source: options.source, fields, required };
}

/**
 * Whether one shape accepts a value.
 * @param fields - The fields the shape's sub-fields are found in.
 * @param path - The shape's path.
 * @param leaf - The shape.
 * @param value - The value.
 * @returns True when it does.
 */
function leafFits(fields: Record<string, Leaf[]>, path: string, leaf: Leaf, value: unknown): boolean {
  if (leaf.enum !== undefined && !leaf.enum.some((v) => v === value)) return false;
  switch (leaf.type) {
    case "any":
      return true;
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (leaf.type === "integer" && !Number.isInteger(value)) return false;
      if (leaf.minimum !== undefined && value < leaf.minimum) return false;
      if (leaf.maximum !== undefined && value > leaf.maximum) return false;
      if (leaf.exclusiveMinimum !== undefined && value <= leaf.exclusiveMinimum) return false;
      return leaf.exclusiveMaximum === undefined || value < leaf.exclusiveMaximum;
    }
    case "array": {
      if (!Array.isArray(value)) return false;
      if (leaf.minItems !== undefined && value.length < leaf.minItems) return false;
      if (leaf.maxItems !== undefined && value.length > leaf.maxItems) return false;
      const items = leaf.items;
      return items === undefined || value.every((item) => fitsAt(items.fields, "", item));
    }
    case "object":
      return isObject(value) && Object.entries(value).every(([key, sub]) => fitsAt(fields, path === "" ? key : `${path}.${key}`, sub));
    default:
      return false;
  }
}

/**
 * Whether a value fits a path of a field table. An item's own shapes sit under "";
 * an object item without them is checked field by field.
 * @param fields - The field table.
 * @param path - The path.
 * @param value - The value.
 * @returns True when some shape at the path accepts it.
 */
function fitsAt(fields: Record<string, Leaf[]>, path: string, value: unknown): boolean {
  const leaves = fields[path];
  if (leaves === undefined) {
    return path === "" && isObject(value) && Object.entries(value).every(([key, sub]) => fitsAt(fields, key, sub));
  }
  return leaves.some((leaf) => leafFits(fields, path, leaf, value));
}

/**
 * Whether the upstream takes a value at a field: some shape at the path accepts it by type,
 * enum, bounds, list length and each item's fields; an object is checked field by field.
 * @param snapshot - The upstream's schema.
 * @param path - The dotted field.
 * @param value - The value written there.
 * @returns False for a field the schema does not have.
 */
export function fieldFits(snapshot: SchemaSnapshot, path: string, value: unknown): boolean {
  return snapshot.fields[path] !== undefined && fitsAt(snapshot.fields, path, value);
}

/**
 * The required fields one object of a body lacks, its nested objects and list items included.
 * @param fields - The field table.
 * @param required - The object's required fields.
 * @param body - The object.
 * @param at - The object's path in the table.
 * @param named - How the object is named in the answer.
 * @returns The missing fields.
 */
function missingIn(fields: Record<string, Leaf[]>, required: readonly string[], body: Record<string, unknown>, at: string, named: string): string[] {
  const missing = required.filter((key) => body[key] === undefined).map((key) => `${named}${key}`);
  for (const [key, value] of Object.entries(body)) {
    const path = at === "" ? key : `${at}.${key}`;
    const leaves = fields[path] ?? [];
    if (isObject(value)) {
      const object = leaves.find((leaf) => leaf.type === "object");
      if (object !== undefined) missing.push(...missingIn(fields, object.required ?? [], value, path, `${named}${key}.`));
    } else if (Array.isArray(value)) {
      const items = leaves.find((leaf) => leaf.type === "array" && leaf.items !== undefined)?.items;
      if (items === undefined) continue;
      value.forEach((item, i) => {
        if (isObject(item)) missing.push(...missingIn(items.fields, items.required, item, "", `${named}${key}[${i}].`));
      });
    }
  }
  return missing;
}

/**
 * The fields the upstream requires that a body lacks: the top level's, a nested object's
 * only when the object is sent, and each list item's as `field[i].sub`.
 * @param snapshot - The upstream's schema.
 * @param body - The request body.
 * @returns The missing fields, empty when none.
 */
export function missingRequired(snapshot: SchemaSnapshot, body: Record<string, unknown>): string[] {
  return missingIn(snapshot.fields, snapshot.required, body, "", "");
}
