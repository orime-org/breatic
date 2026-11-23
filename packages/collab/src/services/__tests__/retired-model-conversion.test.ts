// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * #1521: when collab loads a canvas document, a node saved on a retired model is stored again under its
 * replacement (its model, the models it remembers per mode and the keys of its param records), under a
 * per-document lock, in one transaction, keeping everything the node held.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { CANVAS_NODES_KEY } from "@breatic/shared";

import {
  RETIRED_MODEL_CONVERSION_ORIGIN,
  canvasNeedsModelUpgrade,
  convertRetiredModelsOnLoad,
} from "@collab/services/retired-model-conversion.js";

vi.mock("@breatic/core", () => ({ env: { ENV: "test" } }));

const NAME = "project-p/canvas-s";
const OLD = "gemini-3.1-flash-text-to-speech";
const NEW = "gemini-3.8-flash-text-to-speech";
const PAIR = [{ speaker: "Ava", voice: "Kore" }, { speaker: "Leo", voice: "Puck" }];

const docs: Y.Doc[] = [];

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

/**
 * A canvas document with the given nodes' data, stored the way the canvas writes a node.
 * @param nodes - Node id to its data fields.
 * @returns The document.
 */
function canvasDoc(nodes: Record<string, Record<string, unknown>>): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  doc.transact(() => {
    for (const [id, fields] of Object.entries(nodes)) {
      const node = new Y.Map<unknown>();
      const data = new Y.Map<unknown>();
      doc.getMap(CANVAS_NODES_KEY).set(id, node);
      node.set("type", "audio");
      node.set("data", data);
      for (const [key, value] of Object.entries(fields)) data.set(key, value);
    }
  }, "peer");
  return doc;
}

/**
 * A node's data fields, read back.
 * @param doc - The document.
 * @param id - The node id.
 * @returns Its data as plain values.
 */
function dataOf(doc: Y.Doc, id: string): Record<string, unknown> {
  return ((doc.getMap(CANVAS_NODES_KEY).get(id) as Y.Map<unknown>).get("data") as Y.Map<unknown>).toJSON();
}

/**
 * A copy of a document, as the stored state or a second instance holds it.
 * @param doc - The original.
 * @returns The copy.
 */
function copyOf(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  docs.push(copy);
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

const OLD_NODE = {
  mode: "tts",
  model: OLD,
  modelByMode: { tts: OLD },
  paramsByModel: { [OLD]: { speakers: PAIR, voice_id: "Kore", _stand_in_on: true } },
  prompts: { tts: "Ava: Hi." },
};

describe("convertRetiredModelsOnLoad", () => {
  it("stores a node saved on a retired model under its replacement, keeping what it held", async () => {
    const doc = canvasDoc({ a: OLD_NODE, b: { mode: "tts", model: "minimax-speech-2.8-hd" } });
    const takeLock = vi.fn(async () => true);
    const converted = await convertRetiredModelsOnLoad({ documentName: NAME, document: doc, takeLock, readStored: async () => null });
    expect(converted).toBe(1);
    expect(dataOf(doc, "a")).toEqual({
      mode: "tts",
      model: NEW,
      modelByMode: { tts: NEW },
      paramsByModel: { [NEW]: { speakers: PAIR, voice_id: "Kore", _stand_in_on: true } },
      prompts: { tts: "Ava: Hi." },
    });
    expect(dataOf(doc, "b")).toEqual({ mode: "tts", model: "minimax-speech-2.8-hd" });
    expect(takeLock).toHaveBeenCalledWith("test:collab:lock:retired-model-migrate:project-p/canvas-s");
  });

  it("does nothing, and takes no lock, on a document no node of which names a retired model", async () => {
    const doc = canvasDoc({ a: { model: NEW, modelByMode: { tts: NEW } } });
    const takeLock = vi.fn(async () => true);
    expect(await convertRetiredModelsOnLoad({ documentName: NAME, document: doc, takeLock, readStored: async () => null })).toBe(0);
    expect(takeLock).not.toHaveBeenCalled();
  });

  it("leaves the document alone while another instance holds the lock", async () => {
    const doc = canvasDoc({ a: OLD_NODE });
    expect(await convertRetiredModelsOnLoad({ documentName: NAME, document: doc, takeLock: async () => false, readStored: async () => null })).toBe(0);
    expect(dataOf(doc, "a").model).toBe(OLD);
  });

  it("reads the stored document again under the lock, so a conversion another instance stored is not done twice", async () => {
    const doc = canvasDoc({ a: OLD_NODE });
    const stored = copyOf(doc);
    await convertRetiredModelsOnLoad({ documentName: NAME, document: stored, takeLock: async () => true, readStored: async () => null });
    const converted = await convertRetiredModelsOnLoad({
      documentName: NAME,
      document: doc,
      takeLock: async () => true,
      readStored: async () => Y.encodeStateAsUpdate(stored),
    });
    expect(converted).toBe(0);
    expect(dataOf(doc, "a").model).toBe(NEW);
  });

  it("writes in one transaction under its own origin", async () => {
    const doc = canvasDoc({ a: OLD_NODE, b: { ...OLD_NODE } });
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
    expect(await convertRetiredModelsOnLoad({ documentName: NAME, document: doc, takeLock: async () => true, readStored: async () => null })).toBe(2);
    expect(origins).toEqual([RETIRED_MODEL_CONVERSION_ORIGIN]);
  });

  it("skips a node whose data is not a map, as collaborative data can be anything", async () => {
    const doc = canvasDoc({ a: OLD_NODE });
    doc.transact(() => {
      doc.getMap(CANVAS_NODES_KEY).set("bad", "x");
      const empty = new Y.Map<unknown>();
      doc.getMap(CANVAS_NODES_KEY).set("nodata", empty);
    }, "peer");
    expect(await convertRetiredModelsOnLoad({ documentName: NAME, document: doc, takeLock: async () => true, readStored: async () => null })).toBe(1);
  });
});

describe("canvasNeedsModelUpgrade", () => {
  const name = fc.constantFrom(OLD, NEW, "minimax-speech-2.8-hd");
  // Yjs stores only plain objects, so the generated ones keep Object's prototype.
  const plain = { noNullPrototype: true } as const;
  const node = fc.record(
    {
      model: name,
      modelByMode: fc.dictionary(fc.constantFrom("tts", "sfx"), name, plain),
      paramsByModel: fc.dictionary(name, fc.record({ voice_id: fc.string() }, plain), plain),
    },
    { requiredKeys: [], ...plain },
  );

  it("holds exactly while some node names a retired model, and never after a conversion", async () => {
    await fc.assert(fc.asyncProperty(fc.dictionary(fc.constantFrom("a", "b", "c"), node, plain), async (nodes) => {
      const doc = canvasDoc(nodes);
      const named = Object.values(nodes).some((n) => n.model === OLD || Object.values(n.modelByMode ?? {}).includes(OLD) || Object.keys(n.paramsByModel ?? {}).includes(OLD));
      expect(canvasNeedsModelUpgrade(doc)).toBe(named);
      await convertRetiredModelsOnLoad({ documentName: NAME, document: doc, takeLock: async () => true, readStored: async () => null });
      expect(canvasNeedsModelUpgrade(doc)).toBe(false);
    }));
  });
});
