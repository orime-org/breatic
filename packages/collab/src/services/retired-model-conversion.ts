// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A canvas node saved on a retired model is stored again under its replacement on load (#1521): its `model`, the
 * models it remembers per mode (`modelByMode`) and the keys of its param records (`paramsByModel`), through shared's
 * `withCurrentModelNames`, which web also reads with until this has run. Storing what reading already shows changes
 * nothing on screen.
 */

import * as Y from "yjs";

import { env } from "@breatic/core";
import { CANVAS_NODES_KEY, withCurrentModelNames, type NodeModelFields } from "@breatic/shared";

import type { ConversionOnLoad } from "@collab/services/legacy-table-conversion.js";

/** The transaction origin of the conversion. */
export const RETIRED_MODEL_CONVERSION_ORIGIN = "retired-model-migrate";

/** The node data fields that name a model. */
const MODEL_FIELDS = ["model", "modelByMode", "paramsByModel"] as const;

/**
 * The lock key for one document's conversion.
 * @param documentName - The document's full name.
 * @returns The key.
 * @throws {never} Never.
 */
function conversionLockKey(documentName: string): string {
  return `${env.ENV}:collab:lock:retired-model-migrate:${documentName}`;
}

/**
 * Each node's data map with its model fields as stored and as they read under current names.
 * @param doc - A canvas document.
 * @returns The data maps whose fields name a retired model, with their fields under current names.
 * @throws {never} Never.
 */
function retiredNodes(doc: Y.Doc): { data: Y.Map<unknown>; current: NodeModelFields }[] {
  const out: { data: Y.Map<unknown>; current: NodeModelFields }[] = [];
  doc.getMap(CANVAS_NODES_KEY).forEach((node) => {
    if (!(node instanceof Y.Map)) return;
    const data = node.get("data");
    if (!(data instanceof Y.Map)) return;
    const stored: NodeModelFields = { model: data.get("model"), modelByMode: data.get("modelByMode"), paramsByModel: data.get("paramsByModel") };
    const current = withCurrentModelNames(stored);
    if (current !== stored) out.push({ data, current });
  });
  return out;
}

/**
 * Whether some node of a canvas document names a retired model.
 * @param doc - A canvas document.
 * @returns True when a load must convert it.
 * @throws {never} Never.
 */
export function canvasNeedsModelUpgrade(doc: Y.Doc): boolean {
  return retiredNodes(doc).length > 0;
}

/**
 * Stores a loaded canvas document's nodes under current model names, unless another instance is doing it or already did.
 * @param load - The document and what the conversion needs.
 * @returns How many nodes this instance converted.
 * @throws {Error} Whatever taking the lock or reading the stored document throws.
 */
export async function convertRetiredModelsOnLoad(load: ConversionOnLoad): Promise<number> {
  if (!canvasNeedsModelUpgrade(load.document)) return 0;
  if (!(await load.takeLock(conversionLockKey(load.documentName)))) return 0;
  const stored = await load.readStored();
  if (stored !== null) Y.applyUpdate(load.document, stored, RETIRED_MODEL_CONVERSION_ORIGIN);
  const nodes = retiredNodes(load.document);
  if (nodes.length === 0) return 0;
  load.document.transact(() => {
    for (const { data, current } of nodes) {
      for (const field of MODEL_FIELDS) {
        if (current[field] !== data.get(field)) data.set(field, current[field]);
      }
    }
  }, RETIRED_MODEL_CONVERSION_ORIGIN);
  return nodes.length;
}
