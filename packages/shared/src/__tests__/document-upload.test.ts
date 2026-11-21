// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { documentBodyFragment } from "../document-body.js";
import {
  applyDocumentUpload,
  documentUploadFailure,
  type DocumentUploadEvent,
} from "../document-upload.js";

const HOME = "project-p/document-s";

/**
 * A body holding the given media blocks, each in its own container.
 * @param blocks - The attributes of each block.
 * @returns The document and its body.
 */
function body(blocks: Record<string, unknown>[]): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = documentBodyFragment(doc);
  const group = new Y.XmlElement("blockGroup");
  fragment.insert(0, [group]);
  for (const attrs of blocks) {
    const container = new Y.XmlElement("blockContainer");
    const media = new Y.XmlElement(String(attrs.kind ?? "image"));
    for (const [key, value] of Object.entries(attrs)) if (key !== "kind") media.setAttribute(key, value as never);
    container.insert(0, [media]);
    group.insert(group.length, [container]);
  }
  const paragraph = new Y.XmlElement("blockContainer");
  paragraph.insert(0, [new Y.XmlElement("paragraph")]);
  group.insert(group.length, [paragraph]);
  return { doc, fragment };
}

/**
 * Every media element's attributes, in document order.
 * @param fragment - The body.
 * @returns The attributes.
 */
function media(fragment: Y.XmlFragment): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (parent: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (["image", "video", "audio"].includes(child.nodeName)) out.push({ ...child.getAttributes() });
      walk(child);
    }
  };
  walk(fragment);
  return out;
}

// The shape the editor writes: every declared prop, empty strings included.
const pending = { uploadId: "u1", uploadHome: HOME, url: "", uploadState: "", uploadFailure: "" };
const processing: DocumentUploadEvent = { type: "document-upload", docName: HOME, uploadId: "u1", state: "processing" };
const completed: DocumentUploadEvent = {
  type: "document-upload", docName: HOME, uploadId: "u1", state: "completed",
  result: { url: "https://cdn.example/a.png", mediaWidth: 640, mediaHeight: 480 },
};
const failed: DocumentUploadEvent = { type: "document-upload", docName: HOME, uploadId: "u1", state: "failed", reason: "source_unreachable" };

describe("applyDocumentUpload", () => {
  it("marks a pending block as processing", () => {
    const { fragment } = body([pending]);
    applyDocumentUpload(fragment, processing);
    expect(media(fragment)[0]).toMatchObject({ uploadState: "processing", url: "" });
  });

  it("writes the result into every matching block and clears the upload attributes", () => {
    const { fragment } = body([pending, { ...pending, kind: "image" }]);
    applyDocumentUpload(fragment, processing);
    applyDocumentUpload(fragment, completed);
    for (const attrs of media(fragment)) {
      expect(attrs).toMatchObject({ url: "https://cdn.example/a.png", mediaWidth: 640, mediaHeight: 480, uploadId: "" });
      expect(attrs.uploadState).toBeUndefined();
      expect(attrs.uploadFailure).toBeUndefined();
      expect(attrs.uploadRetryable).toBeUndefined();
    }
  });

  it("writes the failure as the body's short reason and whether it can be retried", () => {
    const { fragment } = body([pending]);
    applyDocumentUpload(fragment, failed);
    expect(media(fragment)[0]).toMatchObject({ uploadState: "failed", uploadFailure: "unreachable", uploadRetryable: true });
  });

  it("leaves blocks of another upload, another home or with an address alone", () => {
    const blocks = [
      { ...pending, uploadId: "other" },
      { ...pending, uploadHome: "project-p/document-other" },
      { ...pending, url: "https://cdn.example/kept.png" },
    ];
    const { fragment } = body(blocks);
    const before = media(fragment);
    expect(applyDocumentUpload(fragment, completed)).toBe(0);
    expect(media(fragment)).toEqual(before);
  });

  it("does not let processing override a failure", () => {
    const { fragment } = body([pending]);
    applyDocumentUpload(fragment, failed);
    applyDocumentUpload(fragment, processing);
    expect(media(fragment)[0]).toMatchObject({ uploadState: "failed" });
  });

  it("lands the same body for any order and repetition of the events of one upload", () => {
    // One grant ends once, so a sequence holds processing plus at most one ending.
    const ending = fc.constantFrom<DocumentUploadEvent | null>(completed, failed, null);
    fc.assert(
      fc.property(ending, fc.array(fc.nat(3), { maxLength: 6 }), fc.array(fc.nat(3), { maxLength: 6 }), (end, orderA, orderB) => {
        const events = end === null ? [processing] : [processing, end];
        const run = (picks: number[]): Record<string, unknown>[] => {
          const { fragment } = body([pending]);
          const sequence = [...events, ...picks.map((i) => events[i % events.length]!)];
          for (const event of sequence) applyDocumentUpload(fragment, event);
          return media(fragment);
        };
        const a = run(orderA);
        const b = run([...orderB].reverse());
        if (end === null) expect(a).toEqual(b);
        else {
          expect(a[0]!.uploadState === "failed" || a[0]!.url !== "").toBe(true);
          expect(a).toEqual(run([]));
        }
      }),
    );
  });
});

describe("documentUploadFailure", () => {
  it("maps a fetch cause to the body's reason and retryability", () => {
    expect(documentUploadFailure("unsupported_type")).toEqual({ reason: "unsupportedType", retryable: false });
    expect(documentUploadFailure("expired")).toEqual({ reason: "failed", retryable: true });
  });

  it("treats an unknown or missing cause as a failure that can be retried", () => {
    expect(documentUploadFailure(undefined)).toEqual({ reason: "failed", retryable: true });
  });
});
