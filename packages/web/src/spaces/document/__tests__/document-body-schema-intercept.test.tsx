// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import * as Y from 'yjs';
import {
  DOCUMENT_BODY_FORMAT,
  DOCUMENT_BODY_FORMAT_VERSION,
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_META_KEY,
  DOCUMENT_SCHEMA_VERSION,
  documentSchemaVersion,
  type DocumentSchema,
} from '@breatic/shared';

import { useDocumentSchemaIntercept } from '@web/spaces/document/use-document-schema-intercept';

type BodySchema = DocumentSchema & {
  readonly bodyFormat: string;
  readonly bodyFormatVersion: number;
};

const docs: Y.Doc[] = [];

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

/** Creates one independently owned metadata document. @returns The metadata document. @throws {never} */
function metadata(): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  return doc;
}

/**
 * Keeps the vocabulary fixed while specifying the body's stored representation.
 * @param bodyFormat - The body's format name.
 * @param bodyFormatVersion - The body's format version.
 * @returns A full declaration from a compatible or differing build.
 * @throws {never}
 */
function schema(
  bodyFormat: string = DOCUMENT_BODY_FORMAT,
  bodyFormatVersion: number = DOCUMENT_BODY_FORMAT_VERSION,
): BodySchema {
  return { ...DOCUMENT_SCHEMA, bodyFormat, bodyFormatVersion };
}

/**
 * Publishes the digest and accompanying declaration as one actual Yjs transaction.
 * @param doc - The metadata document.
 * @param declaration - The schema held by the publishing build.
 * @throws {never}
 */
function publish(doc: Y.Doc, declaration: BodySchema): void {
  doc.transact(() => {
    const map = doc.getMap(DOCUMENT_SCHEMA_META_KEY);
    map.set('version', documentSchemaVersion(declaration));
    map.set('publishedAt', declaration.publishedAt);
    map.set('nodes', declaration.nodes);
    map.set('marks', declaration.marks);
    map.set('content', declaration.content);
    map.set('bodyFormat', declaration.bodyFormat);
    map.set('bodyFormatVersion', declaration.bodyFormatVersion);
  });
}

describe('document body format schema intercept', () => {
  it('admits the same vocabulary and records body contract', () => {
    const doc = metadata();
    publish(doc, schema());

    const { result } = renderHook(() => useDocumentSchemaIntercept({ metaDoc: doc }));

    expect(result.current).toEqual({ intercepted: false, publishedAt: DOCUMENT_SCHEMA.publishedAt });
  });

  it.each([
    ['breatic.document.other', DOCUMENT_BODY_FORMAT_VERSION],
    [DOCUMENT_BODY_FORMAT, 2],
  ] as const)('intercepts a format-only change to %s version %s', (bodyFormat, bodyFormatVersion) => {
    const doc = metadata();
    publish(doc, schema(bodyFormat, bodyFormatVersion));

    const { result } = renderHook(() => useDocumentSchemaIntercept({ metaDoc: doc }));

    expect(result.current).toEqual({ intercepted: true, publishedAt: DOCUMENT_SCHEMA.publishedAt });
  });

  it('derives the updated format verdict when a publication arrives after mounting', () => {
    const doc = metadata();
    publish(doc, schema());
    const { result } = renderHook(() => useDocumentSchemaIntercept({ metaDoc: doc }));
    expect(result.current.intercepted).toBe(false);

    act(() => publish(doc, schema(DOCUMENT_BODY_FORMAT, 2)));

    expect(result.current.intercepted).toBe(true);
  });

  it('keeps vocabulary payload differences under the existing digest-only admission rule', () => {
    const doc = metadata();
    publish(doc, schema());
    doc.transact(() => {
      const map = doc.getMap(DOCUMENT_SCHEMA_META_KEY);
      map.set('version', DOCUMENT_SCHEMA_VERSION);
      map.set('nodes', { retiredBlock: [] });
      map.set('marks', {});
      map.set('content', {});
    });

    const { result } = renderHook(() => useDocumentSchemaIntercept({ metaDoc: doc }));

    expect(result.current.intercepted).toBe(false);
  });
});
