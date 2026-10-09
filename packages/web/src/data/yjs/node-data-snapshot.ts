// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A node's stored data as plain JSON, and back (inner#1349).
 *
 * The clipboard carries a node's whole `data` map. Plain values pass through
 * as they are; the nested Yjs structures are written as tagged JSON so they
 * can be rebuilt without knowing any editor's schema — a text body, a prompt
 * and a shot's prompt are all the same element/text tree.
 *
 * Writing back fills the containers a fresh node was born with instead of
 * replacing them: every mode's prompt container has to exist from birth, or
 * two clients creating it later race and one loses its words (#1880).
 */

import * as Y from 'yjs';

/** A text run inside an element: the delta Y.XmlText gives and takes. */
interface XmlTextNode {
  text: unknown[];
}

/** An element: its name, attributes and children. */
interface XmlElementNode {
  el: string;
  attrs: Record<string, unknown>;
  children: XmlNode[];
}

/** One node of a fragment's tree. */
type XmlNode = XmlTextNode | XmlElementNode;

/** A `Y.XmlFragment`, as JSON. */
interface XmlTag {
  $y: 'xml';
  children: XmlNode[];
}

/** A `Y.Map`, as JSON. */
interface MapTag {
  $y: 'map';
  entries: Record<string, unknown>;
}

/** A `Y.Array`, as JSON. */
interface ArrayTag {
  $y: 'array';
  items: unknown[];
}

/** Any tagged Yjs structure. */
type YTag = XmlTag | MapTag | ArrayTag;

/**
 * Whether a JSON value is a tagged Yjs structure.
 * @param value - The value.
 * @returns True for an xml, map or array tag.
 */
function isTag(value: unknown): value is YTag {
  if (typeof value !== 'object' || value === null) return false;
  const tag = (value as { $y?: unknown }).$y;
  return tag === 'xml' || tag === 'map' || tag === 'array';
}

/**
 * One fragment child as JSON.
 * @param node - The element or text.
 * @returns Its JSON node.
 */
function xmlNodeToJson(node: Y.XmlElement | Y.XmlText): XmlNode {
  if (node instanceof Y.XmlText) return { text: node.toDelta() as unknown[] };
  return {
    el: node.nodeName,
    attrs: { ...node.getAttributes() },
    children: node.toArray().map((child) => xmlNodeToJson(child as Y.XmlElement | Y.XmlText)),
  };
}

/**
 * A Yjs value as JSON; plain values pass through.
 * @param value - The stored value.
 * @returns Its JSON form.
 */
function toJson(value: unknown): unknown {
  if (value instanceof Y.XmlFragment) {
    return {
      $y: 'xml',
      children: value.toArray().map((child) => xmlNodeToJson(child as Y.XmlElement | Y.XmlText)),
    } satisfies XmlTag;
  }
  if (value instanceof Y.Map) {
    const entries: Record<string, unknown> = {};
    value.forEach((entry, key) => {
      entries[key] = toJson(entry);
    });
    return { $y: 'map', entries } satisfies MapTag;
  }
  if (value instanceof Y.Array) {
    return { $y: 'array', items: value.toArray().map(toJson) } satisfies ArrayTag;
  }
  return value;
}

/**
 * A node's stored data, every field, as JSON.
 * @param data - The node's data map.
 * @returns Plain values as they are, nested Yjs structures as tagged JSON.
 */
export function snapshotNodeData(data: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  data.forEach((value, key) => {
    out[key] = toJson(value);
  });
  return out;
}

/**
 * Split a snapshot into what a fresh node is born with and what is filled in
 * after it is in the document.
 * @param snapshot - The node's data snapshot.
 * @returns The plain fields and the tagged structures.
 */
export function splitSnapshot(snapshot: Record<string, unknown>): {
  plain: Record<string, unknown>;
  nested: Record<string, YTag>;
} {
  const plain: Record<string, unknown> = {};
  const nested: Record<string, YTag> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (isTag(value)) nested[key] = value;
    else plain[key] = value;
  }
  return { plain, nested };
}

/**
 * Rebuild one fragment child.
 * @param node - Its JSON node.
 * @returns The element or text.
 */
function xmlNodeFromJson(node: XmlNode): Y.XmlElement | Y.XmlText {
  if ('text' in node) {
    const text = new Y.XmlText();
    text.applyDelta(node.text);
    return text;
  }
  const el = new Y.XmlElement(node.el);
  for (const [key, value] of Object.entries(node.attrs)) el.setAttribute(key, value as string);
  el.insert(0, node.children.map(xmlNodeFromJson));
  return el;
}

/**
 * Rebuild a tagged structure as a new Yjs value; plain values pass through.
 * @param value - The JSON value.
 * @returns The Yjs value.
 */
function fromJson(value: unknown): unknown {
  if (!isTag(value)) return value;
  if (value.$y === 'xml') {
    const fragment = new Y.XmlFragment();
    fragment.insert(0, value.children.map(xmlNodeFromJson));
    return fragment;
  }
  if (value.$y === 'map') {
    const map = new Y.Map<unknown>();
    for (const [key, entry] of Object.entries(value.entries)) map.set(key, fromJson(entry));
    return map;
  }
  const array = new Y.Array<unknown>();
  array.push(value.items.map(fromJson));
  return array;
}

/**
 * Fill a container that already lives in the document from its JSON, keeping
 * the container itself. A fragment's existing children are replaced (a text
 * body is born holding one empty paragraph); a map's entries are filled entry
 * by entry, recursing into containers it already holds; an array is appended to.
 * @param target - The container in the document.
 * @param tag - Its JSON.
 */
function fillInPlace(target: unknown, tag: YTag): void {
  if (tag.$y === 'xml' && target instanceof Y.XmlFragment) {
    target.delete(0, target.length);
    target.insert(0, tag.children.map(xmlNodeFromJson));
    return;
  }
  if (tag.$y === 'map' && target instanceof Y.Map) {
    for (const [key, entry] of Object.entries(tag.entries)) {
      const held: unknown = target.get(key);
      if (isTag(entry) && sameKind(held, entry)) fillInPlace(held, entry);
      else target.set(key, fromJson(entry));
    }
    return;
  }
  if (tag.$y === 'array' && target instanceof Y.Array) {
    target.push(tag.items.map(fromJson));
  }
}

/**
 * Whether a stored value is the container kind a tag describes.
 * @param held - The stored value.
 * @param tag - The JSON tag.
 * @returns True when the tag can be filled into it.
 */
function sameKind(held: unknown, tag: YTag): boolean {
  if (tag.$y === 'xml') return held instanceof Y.XmlFragment;
  if (tag.$y === 'map') return held instanceof Y.Map;
  return held instanceof Y.Array;
}

/**
 * Write a snapshot's nested structures into a node's data map, which must
 * already be in the document. Containers the node was born with are filled in
 * place; anything else is set as a new value.
 * @param data - The node's data map, already in the document.
 * @param nested - The tagged structures from {@link splitSnapshot}.
 */
export function fillNestedData(data: Y.Map<unknown>, nested: Record<string, YTag>): void {
  for (const [key, tag] of Object.entries(nested)) {
    const held: unknown = data.get(key);
    if (sameKind(held, tag)) fillInPlace(held, tag);
    else data.set(key, fromJson(tag));
  }
}
