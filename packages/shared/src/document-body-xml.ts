// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";

import { DocumentBodyFormatError, parseBodyJsonValue } from "@shared/document-body-records-schema.js";
import type { BodyJsonObject } from "@shared/document-body-records-types.js";

/**
 * Reads current XML own attributes without the library's ordinary-object key setter.
 * @param element - An integrated original XML element.
 * @returns Every live JSON attribute, including reserved property names.
 * @throws {DocumentBodyFormatError} If an attribute cannot be represented by the body format.
 */
export function bodyXmlAttributes(element: Y.XmlElement): BodyJsonObject {
  const attrs = Object.fromEntries([...element._map.keys()].filter((key) => element.hasAttribute(key)).map((key) => [key, element.getAttribute(key)]));
  return parseBodyJsonValue(attrs) as BodyJsonObject;
}

/**
 * Copies one XML subtree using the existing native text clone and exact own element attrs.
 * @param node - An original XML element or text node in the conversion snapshot.
 * @returns An unintegrated copy preserving child order and complete JSON values.
 * @throws {DocumentBodyFormatError} If the snapshot contains a non-editor XML type.
 * @throws {Error} If a native text value cannot be read or copied.
 */
export function cloneBodyXmlNode(node: unknown): Y.XmlElement | Y.XmlText {
  if (node instanceof Y.XmlText) return node.clone();
  if (!(node instanceof Y.XmlElement)) throw new DocumentBodyFormatError("Unsupported native XML type in stored body");
  const copy = new Y.XmlElement(node.nodeName);
  for (const [key, value] of Object.entries(bodyXmlAttributes(node))) copy.setAttribute(key, value as never);
  copy.insert(0, node.toArray().map((child) => cloneBodyXmlNode(child)));
  return copy;
}
