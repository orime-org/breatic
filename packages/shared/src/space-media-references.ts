// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";
import type { SpaceType } from "@shared/types/space.js";
import { CANVAS_NODES_KEY } from "@shared/types/canvas-node.js";
import { existingDocumentBodyFragment } from "@shared/document-body.js";
import { TimelineVideoSourceSchema } from "@shared/timeline/schema.js";

const PHYSICAL_NODE_TYPES = new Set(["image", "audio", "video", "3d"]);
const CANVAS_NODE_TYPES = new Set([...PHYSICAL_NODE_TYPES, "text", "web", "annotation", "group"]);
const IMAGE_FIELDS = ["firstFrameUrl", "endFrameUrl", "characterImageUrl", "moodImageUrl"] as const;
const VIDEO_FIELDS = ["drivingVideo", "sourceVideo", "soundVideo"] as const;
const AUDIO_FIELDS = ["drivingAudio", "refAudio", "leftAudio", "rightAudio", "musicSong", "coverSong", "musicMelody", "musicVocal"] as const;

/** Registered identities and physical-media URLs explicitly used by a Space. */
export interface SpaceMediaReferences { assetIds: string[]; urls: string[] }

/**
 * Read semantic media references without modifying the content document.
 * @param kind - The content document's actual Space kind.
 * @param doc - The actual loaded or captured document.
 * @returns Deduplicated identities and URLs in stored media fields.
 * @throws {never} Never.
 */
export function readSpaceMediaReferences(kind: SpaceType, doc: Y.Doc): SpaceMediaReferences {
  const assetIds = new Set<string>();
  const urls = new Set<string>();
  switch (kind) {
    case "canvas":
      readCanvasReferences(doc, urls);
      break;
    case "document": {
      const body = existingDocumentBodyFragment(doc);
      if (body !== undefined) readDocumentReferences(body, urls);
      break;
    }
    case "timeline": {
      if (existingMap(doc, "timeline")?.get("schemaVersion") !== 1) break;
      const sources = existingMap(doc, "sources");
      if (sources === undefined) break;
      for (const value of sources.values()) {
        const parsed = TimelineVideoSourceSchema.safeParse(value instanceof Y.Map ? value.toJSON() : value);
        if (parsed.success) assetIds.add(parsed.data.assetId);
      }
      break;
    }
  }
  return { assetIds: [...assetIds].sort(), urls: [...urls].sort() };
}

/**
 * Type an existing decoded map without creating an absent root.
 * @param doc - The actual content document.
 * @param key - The stored contract key.
 * @returns The existing map, when its type is compatible.
 * @throws {never} Never.
 */
function existingMap(doc: Y.Doc, key: string): Y.Map<unknown> | undefined {
  const held = doc.share.get(key);
  if (held === undefined || (held.constructor !== Y.Map && held.constructor !== Y.AbstractType)) return undefined;
  return doc.getMap(key);
}

/**
 * Read one declared media field from a Yjs map or its plain stored value.
 * @param value - A stored node, data object or slot.
 * @param key - The known semantic field.
 * @returns Its value without recursively scanning arbitrary object content.
 * @throws {never} Never.
 */
function field(value: unknown, key: string): unknown {
  if (value instanceof Y.Map) return value.get(key);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return (value as Record<string, unknown>)[key];
  return undefined;
}

/**
 * Add an explicitly stored reference without deciding whether it is registered.
 * @param urls - The result set.
 * @param value - A known URL field's value.
 * @throws {never} Never.
 */
function addUrl(urls: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.length > 0) urls.add(value);
}

/**
 * Read the two existing encodings of a media-reference pool.
 * @param value - A persisted plain array or Yjs array.
 * @returns Its entries, or an empty collection for an unknown value.
 * @throws {never} Never.
 */
function poolEntries(value: unknown): unknown[] {
  if (value instanceof Y.Array) return value.toArray();
  return Array.isArray(value) ? value : [];
}

/**
 * Read the stored physical outputs and explicit media inputs of Canvas nodes.
 * @param doc - The actual Canvas snapshot.
 * @param urls - The collected semantic references.
 * @throws {never} Never.
 */
function readCanvasReferences(doc: Y.Doc, urls: Set<string>): void {
  const nodes = existingMap(doc, CANVAS_NODES_KEY);
  if (nodes === undefined) return;
  for (const node of nodes.values()) {
    const type = field(node, "type");
    if (typeof type !== "string" || !CANVAS_NODE_TYPES.has(type)) continue;
    const data = field(node, "data");
    if (PHYSICAL_NODE_TYPES.has(type)) addUrl(urls, field(data, "content"));
    if (type === "video") addUrl(urls, field(data, "coverUrl"));
    for (const key of IMAGE_FIELDS) addUrl(urls, field(data, key));
    for (const url of poolEntries(field(data, "styleImageUrls"))) addUrl(urls, url);
    for (const key of VIDEO_FIELDS) {
      const slot = field(data, key);
      addUrl(urls, field(slot, "url"));
      addUrl(urls, field(slot, "cover"));
    }
    for (const key of AUDIO_FIELDS) addUrl(urls, field(field(data, key), "url"));
    for (const key of ["attachments", "focusImages"]) {
      for (const value of poolEntries(field(data, key))) addUrl(urls, field(value, "url"));
    }
  }
}

/**
 * Walk actual editor nodes, including nested blocks and table cells.
 * @param parent - The stored body or one of its XML element containers.
 * @param urls - The collected media URL attributes.
 * @throws {never} Never.
 */
function readDocumentReferences(parent: Y.XmlFragment | Y.XmlElement, urls: Set<string>): void {
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === "image" || child.nodeName === "audio" || child.nodeName === "video") addUrl(urls, child.getAttribute("url"));
    readDocumentReferences(child, urls);
  }
}
